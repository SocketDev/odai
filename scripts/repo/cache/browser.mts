import fs from 'node:fs/promises'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { acquireCacheBrowserSession } from './browser/acquire.mts'
import { assertBrowserSandboxArguments } from './browser/policy.mts'
import { collectGemmaDiagnostics } from './diagnostic.mts'
import { createGemmaNativeDiagnostics } from './native.mts'
import type { GemmaDiagnostics } from './diagnostic.mts'
import type { GemmaNativeDiagnostics } from './native.mts'
import type { BrowserContext, Page } from 'playwright-core'

export { exportGemmaCache, initializeCacheProfile } from './util.mts'
export { parseGemmaKernelFaults } from './kernel.mts'
export { parseGemmaCrash } from './crash.mts'
export { collectGemmaCrashReports } from './crash/collect.mts'
export { buildGemmaModuleInventory } from './image/modules.mts'
export { writeGemmaDiagnosticContext } from './diagnostic/context.mts'
export { probeGemmaWithDiagnostics } from './diagnostic/probe.mts'
export { uploadGemmaDiagnostics } from './diagnostic/retain.mts'
export {
  prepareGemmaReplay,
  uploadGemmaReplay,
  verifyGemmaReplay,
} from './retain.mts'

export interface BrowserProbeConfig {
  allowInsufficientCapacity?: boolean | undefined
  bridge: string
  browser: string
  cpuOverride?: boolean | undefined
  diagnosticRoot?: string | undefined
  offline: boolean
  preserveDiagnostics?: boolean | undefined
  profile: string
  timeoutMs: number
}

interface LanguageSession {
  destroy(): void
  prompt(input: string): Promise<string>
}

interface LanguageApi {
  availability(): Promise<string>
  create(): Promise<LanguageSession>
}

declare const LanguageModel: LanguageApi

export interface ProvisionCapacityConfig {
  allowInsufficientCapacity?: boolean | undefined
  availableParallelism: number
  cpuOverride?: boolean | undefined
  freeDiskBytes: number
  platform: string
  totalMemoryBytes: number
}

export function assertProvisionCapacity(
  profile: string,
  config: ProvisionCapacityConfig,
): void {
  const capacity = { __proto__: null, ...config } as ProvisionCapacityConfig
  if (
    !Number.isFinite(capacity.freeDiskBytes) ||
    capacity.freeDiskBytes < 22 * 1024 ** 3
  ) {
    throw new Error(
      `Gemma provisioning has insufficient disk space at ${profile}. Saw ${Math.floor(capacity.freeDiskBytes / 1024 ** 3)} GiB free; expected at least 22 GiB. Free disk space before provisioning.`,
    )
  }
  if (
    capacity.allowInsufficientCapacity !== true &&
    capacity.cpuOverride !== true &&
    capacity.platform !== 'darwin' &&
    (capacity.availableParallelism < 4 ||
      capacity.totalMemoryBytes < 15_000 * 1024 ** 2)
  ) {
    throw new Error(
      `Gemma CPU capacity is insufficient at ${profile}. Saw ${capacity.availableParallelism} cores and ${Math.floor(capacity.totalMemoryBytes / 1024 ** 2)} MiB RAM; expected 4 cores and 15000 MiB. Use an eligible runner.`,
    )
  }
}

export function assertOfflineNetwork(
  options?:
    | { interfaces?: ReturnType<typeof os.networkInterfaces> | undefined }
    | undefined,
): void {
  const opts = { __proto__: null, ...options } as NonNullable<typeof options>
  const interfaces = opts.interfaces ?? os.networkInterfaces()
  if (
    Object.values(interfaces).some(addresses =>
      addresses?.some(address => !address.internal),
    )
  ) {
    throw new Error(
      'Offline verification is not isolated. Saw a non-loopback network interface; expected Docker --network none. Run the verify command with its isolated container.',
    )
  }
}

export function assertGemmaIdentity(response: string): void {
  if (
    !/\bgemma\s*4\b/i.test(response) ||
    /\bgemini\b|\bnano\b/i.test(response)
  ) {
    throw new Error(
      'Gemma identity was not confirmed in the prompt response. Saw a different or ambiguous model name; expected Gemma 4. Provision the pinned Chrome Beta profile again.',
    )
  }
}

async function inspectBrowser(
  context: BrowserContext,
  page: Page,
): Promise<string> {
  const cdp = await context.newCDPSession(page)
  const version = await cdp.send('Browser.getVersion')
  const major = Number(
    /\/(?<major>\d+)\./.exec(version.product)?.groups?.['major'],
  )
  if (!Number.isSafeInteger(major) || major < 153) {
    throw new Error(
      'Chrome cannot select Gemma 4. Saw an unsupported browser version; expected Chrome 153 or newer. Install the pinned Chrome Beta binary.',
    )
  }
  const command = await cdp.send('Browser.getBrowserCommandLine')
  assertBrowserSandboxArguments(command.arguments)
  return version.product
}

async function assertRetainedGemmaFlag(profile: string): Promise<void> {
  const stateText = await fs.readFile(
    new URL('./Local%20State', pathToFileURL(`${profile}/`)),
    'utf8',
  )
  const state: unknown = JSON.parse(stateText)
  if (
    typeof state !== 'object' ||
    state === null ||
    !('browser' in state) ||
    typeof state.browser !== 'object' ||
    state.browser === null ||
    !('enabled_labs_experiments' in state.browser) ||
    !Array.isArray(state.browser.enabled_labs_experiments) ||
    !state.browser.enabled_labs_experiments.includes('gemma4-for-built-in-ai@1')
  ) {
    throw new Error(
      'Chrome discarded the Gemma selection. Saw no retained Gemma flag; expected gemma4-for-built-in-ai@1. Install the pinned Chrome Beta binary and provision again.',
    )
  }
}

export function canActivateGemma(state: string): boolean {
  return state === 'downloadable' || state === 'downloading'
}

interface ProbeDiagnostics {
  allowInsufficientCapacity: boolean
  availability: string
  cpuOverride: boolean
  firstAvailability: string
  machine: {
    architecture: string
    availableParallelism: number
    freeDiskBytes: number
    platform: string
    totalMemoryBytes: number
  }
  browser: GemmaDiagnostics | null
  native: GemmaNativeDiagnostics | undefined
  nativeLogLimitReached: boolean
}

export class GemmaProbeError extends Error {
  readonly diagnostics: ProbeDiagnostics

  constructor(cause: unknown, diagnostics: ProbeDiagnostics) {
    super(
      'Gemma browser probe failed. Saw unsuccessful session creation or inference; expected a Gemma response. Inspect the attached diagnostics and retry after resolving the failure.',
      { cause },
    )
    this.name = 'GemmaProbeError'
    this.diagnostics = diagnostics
  }
}

export class GemmaProvisionError extends AggregateError {
  readonly diagnostics: Array<ProbeDiagnostics | { status: 'unavailable' }>

  constructor(errors: unknown[]) {
    super(
      errors,
      'Gemma provisioning failed. Where: retained profile probe. Saw failed model attempts; wanted successful inference. Inspect the attempt diagnostics before retrying.',
    )
    this.name = 'GemmaProvisionError'
    this.diagnostics = errors.map(error =>
      error instanceof GemmaProbeError
        ? error.diagnostics
        : { status: 'unavailable' },
    )
  }
}

export async function probeGemmaProvision(config: BrowserProbeConfig) {
  const options = { __proto__: null, ...config } as BrowserProbeConfig
  const deadline = Date.now() + options.timeoutMs
  const failures: unknown[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const receipt = await probeGemmaBrowser({
        ...options,
        timeoutMs: Math.max(1, deadline - Date.now()),
      })
      return Object.assign(receipt, {
        previousAttempts: new GemmaProvisionError(failures).diagnostics,
      })
    } catch (error) {
      if (!(error instanceof GemmaProbeError) && failures.length === 0) {
        throw error
      }
      failures.push(error)
      if (
        !(error instanceof GemmaProbeError) ||
        options.offline ||
        !options.cpuOverride ||
        Date.now() >= deadline
      ) {
        break
      }
    }
  }
  throw new GemmaProvisionError(failures)
}

export async function probeGemmaBrowser(config: BrowserProbeConfig) {
  const options = { __proto__: null, ...config } as BrowserProbeConfig
  const disk = await fs.statfs(options.profile)
  const machine = {
    architecture: os.arch(),
    availableParallelism: os.availableParallelism(),
    freeDiskBytes: disk.bavail * disk.bsize,
    platform: os.platform(),
    totalMemoryBytes: os.totalmem(),
  }
  if (options.offline) {
    assertOfflineNetwork()
  } else {
    assertProvisionCapacity(options.profile, {
      ...machine,
      allowInsufficientCapacity: options.allowInsufficientCapacity,
      cpuOverride: options.cpuOverride,
    })
  }
  let context: BrowserContext | undefined
  let page: Page | undefined
  let browserDiagnostics: GemmaDiagnostics | null = null
  let nativeDiagnostics: GemmaNativeDiagnostics | undefined
  let native:
    | Awaited<ReturnType<typeof createGemmaNativeDiagnostics>>
    | undefined
  let nativeLogLimitReached = false
  let firstAvailability = 'not-checked'
  let timedOut = false
  let lastAvailability = 'not-checked'
  const timer = setTimeout(() => {
    timedOut = true
    void context?.close().catch(() => {})
  }, options.timeoutMs)
  const startedAt = Date.now()
  async function closeBrowser() {
    const closing = context
    context = undefined
    await closing?.close().catch(() => {})
  }
  async function captureDiagnostics() {
    if (context && page && !timedOut) {
      browserDiagnostics = await collectGemmaDiagnostics({
        context,
        page,
        profile: options.profile,
        timeoutMs: Math.max(0, options.timeoutMs - (Date.now() - startedAt)),
      })
    }
  }
  async function recordAvailability(state: string) {
    lastAvailability = state
    if (firstAvailability === 'not-checked') {
      firstAvailability = state
      await captureDiagnostics()
    }
  }
  function diagnostics(): ProbeDiagnostics {
    return {
      allowInsufficientCapacity: options.allowInsufficientCapacity === true,
      availability: lastAvailability,
      cpuOverride: options.cpuOverride === true,
      firstAvailability,
      machine,
      browser: browserDiagnostics,
      native: nativeDiagnostics,
      nativeLogLimitReached,
    }
  }
  async function acquireBrowser() {
    native = await createGemmaNativeDiagnostics({
      root: options.diagnosticRoot,
      preserve: options.preserveDiagnostics,
      timeoutMs: options.timeoutMs - (Date.now() - startedAt),
      onLimit() {
        nativeLogLimitReached = true
        void context?.close().catch(() => {})
      },
    })
    const launchBudget = options.timeoutMs - (Date.now() - startedAt)
    if (timedOut || launchBudget <= 0) {
      throw new Error(
        'Gemma startup exceeded its deadline. Where: browser acquisition. Saw an exhausted budget; wanted time to start Chrome. Check diagnostic setup and retry.',
      )
    }
    const acquired = await acquireCacheBrowserSession({
      cpuOverride: options.cpuOverride,
      executablePath: options.browser,
      logFile: native.logFile,
      network: options.offline ? 'offline' : 'provision',
      profileDir: options.profile,
      timeoutMs: launchBudget,
    })
    context = acquired.context
    if (nativeLogLimitReached) {
      throw new Error(
        'Gemma diagnostics exceeded the log limit. Where: Chrome startup. Saw an oversized native log; wanted bounded capture. Inspect the sanitized events before retrying.',
      )
    }
    if (timedOut) {
      throw new Error(
        'Chrome launch exceeded the odai timeout. Saw a late browser process; expected startup within the budget. Check runner capacity and retry.',
      )
    }
    return acquired
  }
  try {
    const acquired = await acquireBrowser()
    context = acquired.context
    page = acquired.page
    const browserVersion = await inspectBrowser(context, page)
    await page.goto(pathToFileURL(options.bridge).href)
    await captureDiagnostics()
    let activationStarted = false
    let available = false
    while (!timedOut) {
      const state = await page.evaluate(async () => {
        const api =
          typeof LanguageModel === 'undefined' ? undefined : LanguageModel
        return api ? await api.availability() : 'missing-api'
      })
      await recordAvailability(state)
      if (state === 'available') {
        available = true
        break
      }
      if (state === 'missing-api') {
        throw new Error(
          `Gemma is not ready in the copied profile. Saw ${state}; expected available without downloading. Provision and export the model again.`,
        )
      }
      if (!options.offline && !activationStarted && canActivateGemma(state)) {
        activationStarted = true
        await page.evaluate(async () => {
          const api = LanguageModel
          const session = await api.create()
          session.destroy()
        })
      }
      await delay(
        Math.min(
          2000,
          Math.max(1, options.timeoutMs - (Date.now() - startedAt)),
        ),
      )
    }
    if (!available || timedOut) {
      throw new Error(
        'Gemma provisioning exceeded its timeout. Saw no available model; expected completed provisioning. Check Chrome capacity and download access, then retry.',
      )
    }
    const response = await page.evaluate(async () => {
      const api = LanguageModel
      const session = await api.create()
      try {
        return await session.prompt(
          'What model are you? Reply with your model family and version only.',
        )
      } finally {
        session.destroy()
      }
    })
    assertGemmaIdentity(response)
    await captureDiagnostics()
    await context.close()
    context = undefined
    nativeDiagnostics = await native?.read()
    await assertRetainedGemmaFlag(options.profile)
    return {
      __proto__: null,
      ...machine,
      browserVersion,
      allowInsufficientCapacity: options.allowInsufficientCapacity === true,
      cpuOverride: options.cpuOverride === true,
      diagnostics: diagnostics(),
      identityEvidence: 'model-response-and-retained-flag',
      model: 'gemma4',
      offline: options.offline,
      response,
      sandbox: true,
    }
  } catch (cause) {
    await captureDiagnostics()
    await closeBrowser()
    nativeDiagnostics = await native?.read()
    if (timedOut) {
      throw new GemmaProbeError(
        new Error(
          `Gemma provisioning exceeded its timeout. Saw availability ${lastAvailability}; expected an available model. Check Chrome capacity and download access, then retry.`,
          { cause: { availability: lastAvailability, error: cause } },
        ),
        diagnostics(),
      )
    }
    throw new GemmaProbeError(cause, diagnostics())
  } finally {
    clearTimeout(timer)
    await closeBrowser()
    await native?.close()
  }
}
