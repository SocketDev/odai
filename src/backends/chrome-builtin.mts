/**
 * @file Chrome built-in AI backend (headless bridge). Inside Chrome the
 *   runtime's `LanguageModel` global is used directly. In Node the backend
 *   launches REAL Google Chrome — Chromium builds lack
 *   `optimization_guide_internal` and cannot run the on-device model — with
 *   `--headless=new` via playwright-core and proxies the page's
 *   `LanguageModel` global across `page.evaluate`. Two first-class
 *   provisioning modes: system-Chrome mode clones the machine's
 *   already-downloaded model component into a odai-owned profile with
 *   copy-on-write — zero weights download, the live Chrome profile is never
 *   written — and CI mode downloads the component once into a cacheable
 *   profile when downloads are explicitly allowed. Provisioning lives in
 *   `chrome-profile.mts`, the page proxy in `chrome-page.mts`.
 */

import { getLanguageModel, probeAvailability } from '../availability.mts'
import {
  createPageBoundFactory,
  STREAM_BINDING_NAME,
  waitForModelReady,
} from './chrome-page.mts'
import {
  chromeMissingReason,
  ensureBridgeProfile,
  findModelSource,
  isNodeRuntime,
  pathToFileUrl,
  resolveBridgeConfig,
} from './chrome-profile.mts'
import type { LanguageModelLike, Message, SessionLike } from '../types.mts'
import type {
  Bridge,
  ChromiumLauncherLike,
  StreamPayload,
  StreamQueue,
} from './chrome-page.mts'
import type { BackendAvailability, OdaiBackend } from './types.mts'

export type {
  BrowserContextLike,
  ChromiumLauncherLike,
  PageLike,
} from './chrome-page.mts'
export {
  MODEL_COMPONENT_DIR,
  ODAI_CHROME_ALLOW_DOWNLOAD_ENV_VAR,
  ODAI_CHROME_ENV_VAR,
  ODAI_CHROME_USER_DATA_DIR_ENV_VAR,
} from './chrome-profile.mts'

/**
 * Playwright defaults that break the on-device model and must not reach
 * Chrome: `--disable-component-update` blocks local component adoption, and
 * background networking / field-trial config are load-bearing for component
 * plus model delivery.
 */
const IGNORED_DEFAULT_ARGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-field-trial-config',
]

/**
 * Replacement for playwright's `--disable-features` switch, whose default
 * list includes the model-killing `OptimizationHints`: Chrome honors the last
 * occurrence, so appending this keeps the quiet-automation intent while
 * dropping the kill.
 */
const LAUNCH_ARGS = [
  '--disable-features=DialMediaRouteProvider,GlobalMediaControls,MediaRouter,Translate',
]

export const CHROME_BUILTIN_UNAVAILABLE_REASON =
  'chrome-builtin needs a LanguageModel global that reports available, ' +
  'or a Node runtime with Google Chrome to drive headlessly.'

export interface ChromeBuiltinOptions {
  /**
   * Allow the one-time in-CI model component download when no local model can
   * be cloned. The `ODAI_CHROME_ALLOW_DOWNLOAD` env var (`1`/`true`) is the
   * string form. Off by default: local runs must be zero-download.
   */
  allowDownload?: boolean | undefined
  /**
   * Google Chrome executable. Falls back to the `ODAI_CHROME` env var, then
   * per-OS well-known install paths. Must be real Chrome — Chromium builds
   * cannot run the on-device model.
   */
  chromePath?: string | undefined
  /**
   * Env source, `process.env` by default. Injectable for tests.
   */
  env?: Record<string, string | undefined> | undefined
  /**
   * Playwright-shaped launcher, `playwright-core`'s `chromium` by default.
   * Injectable for tests.
   */
  launcher?: ChromiumLauncherLike | undefined
  /**
   * How long to wait for the model to report `available` after launch.
   * Defaults to 2 minutes, or 30 minutes when downloads are allowed.
   */
  readyTimeoutMs?: number | undefined
  /**
   * The system Chrome user-data dir to clone the downloaded model from.
   * Defaults to the per-OS Google Chrome location. Only ever read.
   */
  systemChromeUserDataDir?: string | undefined
  /**
   * The odai-owned Chrome profile the bridge launches with. Falls back to
   * the `ODAI_CHROME_USER_DATA_DIR` env var, then a per-user cache dir.
   * Persistent on purpose: first activation registers the model component
   * with one small keyless metadata exchange, and later launches work
   * offline.
   */
  userDataDir?: string | undefined
}

export interface ChromeBuiltinBackend extends OdaiBackend {
  /**
   * Close the headless Chrome bridge if one was launched.
   */
  close(): Promise<void>
}

export function createChromeBuiltinBackend(
  options?: ChromeBuiltinOptions | undefined,
): ChromeBuiltinBackend {
  const opts = { __proto__: null, ...options } as ChromeBuiltinOptions
  let bridgePromise: Promise<Bridge> | undefined
  return {
    async availability(): Promise<BackendAvailability> {
      const probe = await probeAvailability()
      if (probe.available) {
        return { available: true }
      }
      if (getLanguageModel() !== undefined) {
        return {
          available: false,
          reason:
            'the runtime LanguageModel global reports the model is not ' +
            'available on this device.',
        }
      }
      if (!isNodeRuntime()) {
        return { available: false, reason: CHROME_BUILTIN_UNAVAILABLE_REASON }
      }
      const config = await resolveBridgeConfig(opts)
      if (config.chromePath === undefined) {
        return { available: false, reason: chromeMissingReason(config) }
      }
      const { reason } = await loadLauncher(opts)
      if (reason !== undefined) {
        return { available: false, reason }
      }
      const source = await findModelSource(config)
      if (source.reason !== undefined) {
        return { available: false, reason: source.reason }
      }
      return { available: true }
    },
    async close(): Promise<void> {
      if (bridgePromise !== undefined) {
        const pending = bridgePromise
        bridgePromise = undefined
        const bridge = await pending.catch(() => undefined)
        await bridge?.close()
      }
    },
    async languageModel(): Promise<LanguageModelLike> {
      const model = getLanguageModel()
      if (model !== undefined) {
        // In-browser native path: sessions come straight from the runtime
        // global, so wrap them to feature-detect responseConstraint. The Node
        // bridge below feature-detects inside Chrome (see pagePrompt).
        return wrapFactoryWithConstraintFallback(model)
      }
      if (!isNodeRuntime()) {
        throw new Error(CHROME_BUILTIN_UNAVAILABLE_REASON)
      }
      bridgePromise ??= startBridge(opts)
      try {
        return createPageBoundFactory(await bridgePromise)
      } catch (error) {
        bridgePromise = undefined
        throw error
      }
    },
    name: 'chrome-builtin',
  }
}

export async function loadLauncher(options: ChromeBuiltinOptions): Promise<{
  launcher?: ChromiumLauncherLike | undefined
  reason?: string | undefined
}> {
  const opts = { __proto__: null, ...options } as ChromeBuiltinOptions
  if (opts.launcher !== undefined) {
    return { launcher: opts.launcher }
  }
  try {
    const playwright = await import('playwright-core')
    // Structural narrowing: playwright's Page/BrowserContext carry far more
    // surface than the bridge drives.
    return {
      launcher: playwright.chromium as unknown as ChromiumLauncherLike,
    }
  } catch {
    return {
      reason:
        'playwright-core is not installed; add it to drive headless Chrome ' +
        'from Node.',
    }
  }
}

export async function startBridge(
  options: ChromeBuiltinOptions,
): Promise<Bridge> {
  const opts = { __proto__: null, ...options } as ChromeBuiltinOptions
  const config = await resolveBridgeConfig(opts)
  if (config.chromePath === undefined) {
    throw new Error(chromeMissingReason(config))
  }
  const { launcher, reason } = await loadLauncher(opts)
  if (launcher === undefined) {
    throw new Error(reason)
  }
  const source = await findModelSource(config)
  if (source.reason !== undefined) {
    throw new Error(source.reason)
  }
  const bridgePagePath = await ensureBridgeProfile(config, source)
  const context = await launcher.launchPersistentContext(config.userDataDir, {
    args: LAUNCH_ARGS,
    executablePath: config.chromePath,
    headless: true,
    ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
  })
  const streams = new Map<number, StreamQueue>()
  try {
    const page = await context.newPage()
    await page.exposeFunction(STREAM_BINDING_NAME, (payload: StreamPayload) => {
      streams.get(payload.streamId)?.push(payload)
    })
    // file:// is a secure context; the Prompt API is not exposed on
    // about:blank or data: URLs.
    await page.goto(pathToFileUrl(bridgePagePath))
    await waitForModelReady(page, {
      allowDownload: config.allowDownload,
      readyTimeoutMs: opts.readyTimeoutMs,
      userDataDir: config.userDataDir,
    })
    return {
      close: () => context.close(),
      page,
      streams,
    }
  } catch (error) {
    await context.close().catch(() => undefined)
    throw error
  }
}

/**
 * Wrap a native `LanguageModelLike` (the in-browser `LanguageModel` global) so
 * every session it hands out feature-detects `responseConstraint`: the option
 * is forwarded to the native `prompt` when present, and an unsupported-option
 * throw reverts to a plain `prompt(messages)`. Cloned sessions are wrapped the
 * same way so the fallback survives per-request clones. The Node bridge path
 * feature-detects inside Chrome instead (see `pagePrompt`).
 */
export function wrapFactoryWithConstraintFallback(
  model: LanguageModelLike,
): LanguageModelLike {
  return {
    availability(): Promise<string> | { availability: string } {
      return model.availability()
    },
    async create(options?: object | undefined): Promise<SessionLike> {
      return wrapSessionWithConstraintFallback(await model.create(options))
    },
  }
}

export function wrapSessionWithConstraintFallback(
  session: SessionLike,
): SessionLike {
  const wrapped: SessionLike = {
    async prompt(
      messages: Message[],
      options?: { responseConstraint?: object | undefined } | undefined,
    ): Promise<string> {
      const opts = { __proto__: null, ...options } as typeof options
      const responseConstraint = opts?.responseConstraint
      if (responseConstraint !== undefined) {
        try {
          return await session.prompt(messages, { responseConstraint })
        } catch {
          // Unsupported option or a throw — fall back to a plain prompt.
        }
      }
      return session.prompt(messages)
    },
    promptStreaming(
      messages: Message[],
    ): AsyncIterable<string> | ReadableStream<string> {
      return session.promptStreaming(messages)
    },
  }
  const { clone, destroy } = session
  if (typeof clone === 'function') {
    wrapped.clone = async (): Promise<SessionLike> =>
      wrapSessionWithConstraintFallback(await clone.call(session))
  }
  if (typeof destroy === 'function') {
    wrapped.destroy = (): void => destroy.call(session)
  }
  return wrapped
}
