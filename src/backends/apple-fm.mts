/**
 * @file Apple Foundation Models backend. Bridges the macOS 26+
 *   FoundationModels framework through a tiny Swift stdio shim: the shim is
 *   compiled from embedded source on first use with `xcrun swiftc`, cached
 *   under node_modules/.cache/odai/, and spoken to over line-delimited JSON.
 *   Availability is probed honestly — macOS 26 or newer, Apple silicon, and
 *   Apple Intelligence enabled are all required, and the precise
 *   FoundationModels reason surfaces otherwise. Hosted macOS CI runners are
 *   VMs and report deviceNotEligible; self-hosted Apple silicon is the only
 *   CI home. Prompting is single-shot; streaming yields one chunk in v1.
 */

import { errorMessage } from '@socketsecurity/lib/errors/message'

import type { CreateOptions } from '../session.mts'
import type { LanguageModelLike, SessionLike } from '../types.mts'
import type {
  ShimCommand,
  ShimHandle,
  ShimSessionSpec,
} from './apple-fm-shim.mts'
import type { BackendAvailability, OdaiBackend } from './types.mts'

export const ODAI_APPLE_FM_SHIM_ENV_VAR = 'ODAI_APPLE_FM_SHIM'

const AVAILABILITY_TIMEOUT_MS = 10_000
/**
 * Darwin kernel 25 is macOS 26 — the first release with FoundationModels.
 */
const DARWIN_MACOS_26_MAJOR = 25

export interface AppleFmBackendOptions {
  /**
   * Directory for the compiled shim binary. Defaults to
   * node_modules/.cache/odai under the current working directory.
   */
  cacheDir?: string | undefined
  /**
   * Env source, `process.env` by default. Injectable for tests.
   */
  env?: Record<string, string | undefined> | undefined
  /**
   * Shim override: skips the host checks and the swiftc build, and trusts
   * the given command to speak the shim protocol. The `ODAI_APPLE_FM_SHIM`
   * env var is the string form — a path to a prebuilt shim binary, or a
   * `.js`/`.mjs`/`.cjs`/`.mts` script run with the current Node executable.
   */
  shim?: ShimCommand | undefined
}

export interface AppleFmHostCheck {
  reason?: string | undefined
  supported: boolean
}

/**
 * The surface of `apple-fm-shim.mts` this backend drives — typed structurally
 * so the module is only ever loaded through the lazy `import()`.
 */
export interface ShimModule {
  createShimSession(spec: ShimSessionSpec): SessionLike
  currentHost(): { arch: string; darwinMajor: number; platform: string }
  ensureShimBinary(cacheDir: string): Promise<string>
  spawnShim(command: ShimCommand): ShimHandle
}

/**
 * Pure host gate ahead of the shim build: FoundationModels exists only on
 * macOS 26 or newer running on Apple silicon.
 */
export function checkAppleFmHost(host: {
  arch: string
  darwinMajor: number
  platform: string
}): AppleFmHostCheck {
  if (host.platform !== 'darwin') {
    return {
      reason:
        'Apple Foundation Models need macOS 26 or newer; this host is ' +
        `${host.platform}.`,
      supported: false,
    }
  }
  if (host.arch !== 'arm64') {
    return {
      reason: `Apple Foundation Models need Apple silicon; this Mac is ${host.arch}.`,
      supported: false,
    }
  }
  if (host.darwinMajor < DARWIN_MACOS_26_MAJOR) {
    return {
      reason:
        'Apple Foundation Models need macOS 26 or newer; this host reports ' +
        `Darwin kernel ${host.darwinMajor}.`,
      supported: false,
    }
  }
  return { supported: true }
}

export function createAppleFmBackend(
  options?: AppleFmBackendOptions | undefined,
): OdaiBackend {
  const opts = { __proto__: null, ...options } as AppleFmBackendOptions
  return {
    async availability(): Promise<BackendAvailability> {
      return await probeAppleFm(opts)
    },
    async languageModel(): Promise<LanguageModelLike> {
      return {
        async availability(): Promise<string> {
          const result = await probeAppleFm(opts)
          return result.available ? 'available' : 'unavailable'
        },
        async create(createOptions?: object | undefined): Promise<SessionLike> {
          const shim = await loadShimModule()
          const command = await resolveShimCommand(opts, shim)
          const create = {
            __proto__: null,
            ...createOptions,
          } as CreateOptions
          // topK is accepted and dropped — FoundationModels GenerationOptions
          // has no topK knob.
          return shim.createShimSession({
            command,
            initialPrompts: create.initialPrompts,
            instructions: create.systemPrompt,
            temperature: create.temperature,
          })
        },
      }
    },
    name: 'apple-fm',
  }
}

export function defaultCacheDir(): string {
  return `${process.cwd()}/.cache/odai`
}

/**
 * Map a FoundationModels unavailability reason to actionable guidance while
 * keeping the raw enum token greppable.
 */
export function describeUnavailableReason(reason: string): string {
  if (reason === 'appleIntelligenceNotEnabled') {
    return (
      'Apple Intelligence reports appleIntelligenceNotEnabled — turn it on ' +
      'in System Settings, let the model assets download, and retry.'
    )
  }
  if (reason === 'deviceNotEligible') {
    return (
      'Apple Intelligence reports deviceNotEligible — hosted macOS CI ' +
      'runners are VMs and never qualify; only bare-metal Apple silicon does.'
    )
  }
  if (reason === 'modelNotReady') {
    return (
      'Apple Intelligence reports modelNotReady — the on-device model ' +
      'assets are still downloading; retry when they finish.'
    )
  }
  return `Apple Intelligence reports ${reason}.`
}

/**
 * Load the Node-only shim module, converting a bundler-shimmed or
 * browser-runtime import failure into an actionable error — apple-fm needs
 * the Node build.
 */
export async function loadShimModule(): Promise<ShimModule> {
  try {
    return await import('./apple-fm-shim.mts')
  } catch (error) {
    throw new Error(
      'the Apple Foundation Models shim module failed to load in this ' +
        `bundle — apple-fm needs the Node build: ${errorMessage(error)}`,
    )
  }
}

export async function probeAppleFm(
  options: AppleFmBackendOptions,
): Promise<BackendAvailability> {
  const opts = { __proto__: null, ...options } as AppleFmBackendOptions
  if (typeof process === 'undefined' || process.versions?.node === undefined) {
    return {
      available: false,
      reason:
        'Apple Foundation Models need a Node runtime to spawn the shim; ' +
        'this runtime is not Node.',
    }
  }
  let shim: ShimModule
  try {
    shim = await loadShimModule()
  } catch (error) {
    return { available: false, reason: errorMessage(error) }
  }
  let command: ShimCommand
  const override = opts.shim ?? readEnvShim(opts.env)
  if (override === undefined) {
    const host = checkAppleFmHost(shim.currentHost())
    if (!host.supported) {
      return { available: false, reason: host.reason }
    }
    try {
      command = {
        args: [],
        command: await shim.ensureShimBinary(
          opts.cacheDir ?? defaultCacheDir(),
        ),
      }
    } catch (error) {
      return {
        available: false,
        reason:
          'the Apple Foundation Models shim could not be built: ' +
          errorMessage(error),
      }
    }
  } else {
    command = override
  }
  const handle = shim.spawnShim(command)
  try {
    const reply = await handle.request(
      { op: 'availability' },
      AVAILABILITY_TIMEOUT_MS,
    )
    if (reply['ok'] !== true) {
      return {
        available: false,
        reason:
          'the Apple Foundation Models shim failed: ' +
          String(reply['error'] ?? 'unknown error'),
      }
    }
    if (reply['availability'] === 'available') {
      return { available: true }
    }
    return {
      available: false,
      reason: describeUnavailableReason(String(reply['reason'] ?? 'unknown')),
    }
  } catch (error) {
    return {
      available: false,
      reason:
        'the Apple Foundation Models shim probe failed: ' + errorMessage(error),
    }
  } finally {
    handle.dispose()
  }
}

export function readEnvShim(
  env: Record<string, string | undefined> | undefined,
): ShimCommand | undefined {
  const source = env ?? process.env
  const value = source[ODAI_APPLE_FM_SHIM_ENV_VAR]
  if (value === undefined || value === '') {
    return undefined
  }
  return shimCommandFromPath(value)
}

export async function resolveShimCommand(
  options: AppleFmBackendOptions,
  shim: ShimModule,
): Promise<ShimCommand> {
  const opts = { __proto__: null, ...options } as AppleFmBackendOptions
  if (opts.shim !== undefined) {
    return opts.shim
  }
  const envShim = readEnvShim(opts.env)
  if (envShim !== undefined) {
    return envShim
  }
  return {
    args: [],
    command: await shim.ensureShimBinary(opts.cacheDir ?? defaultCacheDir()),
  }
}

export function shimCommandFromPath(value: string): ShimCommand {
  if (/\.(?:cjs|js|mjs|mts)$/.test(value)) {
    return { args: [value], command: process.execPath }
  }
  return { args: [], command: value }
}
