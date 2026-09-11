import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isPlainObject } from '@socketsecurity/lib-stable/objects/predicates'
import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'
import type { BrowserContext, Page } from 'playwright-core'

const CHILD_PROCESS_HISTOGRAMS = new Set([
  'ChildProcess.Crashed2',
  'ChildProcess.DisconnectedAlive2',
  'ChildProcess.Killed2',
])
const GEMMA_ASSET_NAMES = new Set([
  'classifier_component',
  'gemma4_4b_component',
  'gemma4_12b_component',
  'gemma4_component',
  'generalized_safety_model_component',
  'language_detection_model_component',
  'nano_v3_cpu_component',
  'nano_v3_gpu_component',
  'proofreader_small_expert_model_component',
  'speech_recognition_small_expert_model_component',
  'summarizer_small_expert_model_component',
])
const GEMMA_ASSET_STATES = [
  'not-installed',
  'registering',
  'background-installing',
  'foreground-installing',
  'ready',
  'uninstalling',
] as const

type DiagnosticChannel<T> =
  | { status: 'captured'; data: T }
  | { status: 'timed-out' | 'unavailable' }

export interface GemmaDiagnostics {
  broker: DiagnosticChannel<NonNullable<ReturnType<typeof sanitizeGemmaBroker>>>
  histograms: DiagnosticChannel<
    NonNullable<ReturnType<typeof sanitizeGemmaHistograms>>
  >
  preferences: DiagnosticChannel<ReturnType<typeof sanitizeGemmaPreferences>>
}

export interface GemmaDiagnosticConfig {
  context: BrowserContext
  page: Page
  profile: string
  timeoutMs: number
}

function diagnosticInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function diagnosticBytes(value: unknown): number | undefined {
  return typeof value === 'bigint'
    ? value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : undefined
    : diagnosticInteger(value)
}

function diagnosticBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function diagnosticAsset(value: { [key: PropertyKey]: unknown }) {
  const name = value['name']
  const state = diagnosticInteger(value['state'])
  const version = value['version']
  const error = value['error']
  return {
    __proto__: null,
    name:
      typeof name === 'string' && GEMMA_ASSET_NAMES.has(name) ? name : 'other',
    state,
    stateLabel: GEMMA_ASSET_STATES[state ?? -1] ?? 'unknown',
    version:
      typeof version === 'string' && /^\d{1,10}(?:\.\d{1,10}){3}$/.test(version)
        ? version
        : undefined,
    bytesDownloaded: diagnosticBytes(value['bytesDownloaded']),
    bytesTotal: diagnosticBytes(value['bytesTotal']),
    hasError:
      typeof error === 'string'
        ? error.length > 0
        : error === null
          ? false
          : undefined,
  }
}

function diagnosticRows(value: unknown) {
  const rows: unknown[] = Array.isArray(value) ? value : []
  return rows.slice(0, 64).filter(isPlainObject)
}

function diagnosticModel(value: { [key: PropertyKey]: unknown }) {
  const backendType = [
    'CPU',
    'GPU (highest quality)',
    'GPU (fastest inference)',
  ].includes(String(value['backendType']))
    ? String(value['backendType'])
    : 'unknown'
  const name = value['name']
  const weightsPath = value['weightsPath']
  // Read the public component version from Chrome's exact model asset layout.
  const componentVersion =
    typeof weightsPath === 'string'
      ? /\/OptGuideManifestModel\/[a-f0-9]{64}\/(?<version>\d{1,10}(?:\.\d{1,10}){3})\/weights\.bin$/.exec(
          normalizePath(weightsPath),
        )?.groups?.['version']
      : undefined
  return {
    __proto__: null,
    backendType,
    folderSize: diagnosticBytes(value['folderSize']),
    ...(typeof name === 'string' &&
    /^(?:gemma|nano)[a-z0-9_.-]{0,80}$/i.test(name)
      ? { name }
      : {}),
    ...(componentVersion ? { componentVersion } : {}),
  }
}

export function sanitizeGemmaBroker(value: unknown) {
  if (!isPlainObject(value)) {
    return undefined
  }
  const properties = diagnosticRows(value['properties'])
  const performanceClass = properties.find(
    row => row['description'] === 'Performance Class',
  )?.['value']
  const deviceCapable = properties.find(
    row => row['description'] === 'Device Capable',
  )?.['value']
  return {
    __proto__: null,
    assets: diagnosticRows(value['assets']).map(diagnosticAsset),
    isAssetManagerInitialized: diagnosticBoolean(
      value['isAssetManagerInitialized'],
    ),
    deviceCapable:
      deviceCapable === 'true'
        ? true
        : deviceCapable === 'false'
          ? false
          : undefined,
    maxModelCrashCount: diagnosticInteger(value['maxModelCrashCount']),
    modelCrashCount: diagnosticInteger(value['modelCrashCount']),
    models: diagnosticRows(value['models']).map(diagnosticModel),
    performanceClass:
      typeof performanceClass === 'string' &&
      /^(?:Error|FailedToLoadLibrary|GpuBlocked|High|Low|Medium|Not available yet|ServiceCrash|Unknown|VeryHigh|VeryLow)$/.test(
        performanceClass,
      )
        ? performanceClass
        : undefined,
    useCases: diagnosticRows(value['useCases']).map(row => ({
      __proto__: null,
      name:
        typeof row['name'] === 'string' &&
        /^(?:language_model|prompt_api|prompt_api_gemma4|proofreader|rewriter|summarizer|writer)$/.test(
          row['name'],
        )
          ? row['name']
          : 'other',
      assetsRequested: diagnosticBoolean(row['assetsRequested']),
      unavailableReason: diagnosticInteger(row['unavailableReason']),
    })),
  }
}

export function sanitizeGemmaPreferences(value: unknown) {
  const guide = isPlainObject(value) ? value['optimization_guide'] : undefined
  const state =
    isPlainObject(guide) && isPlainObject(guide['on_device'])
      ? guide['on_device']
      : {}
  const version = state['performance_class_version']
  return {
    __proto__: null,
    modelCrashCount: diagnosticInteger(state['model_crash_count']),
    performanceClass: diagnosticInteger(state['performance_class']),
    performanceClassVersion:
      typeof version === 'string' && /^\d{1,10}(?:\.\d{1,10}){3}$/.test(version)
        ? version
        : undefined,
  }
}

export function sanitizeGemmaHistograms(value: unknown) {
  if (!isPlainObject(value) || !Array.isArray(value['histograms'])) {
    return undefined
  }
  return diagnosticRows(value['histograms']).flatMap(row => {
    const name = row['name']
    const count = diagnosticInteger(row['count'])
    const sum = diagnosticInteger(row['sum'])
    if (
      typeof name !== 'string' ||
      (!CHILD_PROCESS_HISTOGRAMS.has(name) &&
        !/^(?:OnDeviceModel|OptimizationGuide\.ModelExecution\.OnDevice)[A-Za-z0-9.]{1,140}$/.test(
          name,
        )) ||
      count === undefined ||
      sum === undefined
    ) {
      return []
    }
    const buckets = diagnosticRows(row['buckets']).flatMap(bucket => {
      const low = diagnosticInteger(bucket['low'])
      const high = diagnosticInteger(bucket['high'])
      const bucketCount = diagnosticInteger(bucket['count'])
      return low === undefined ||
        high === undefined ||
        bucketCount === undefined
        ? []
        : [{ low, high, count: bucketCount }]
    })
    return [{ name, count, sum, buckets }]
  })
}

async function readBroker(context: BrowserContext, timeoutMs: number) {
  const page = await context.newPage()
  const deadline = Date.now() + timeoutMs
  function remainingTimeout() {
    return Math.max(1, deadline - Date.now())
  }
  try {
    const brokerUrl = 'chrome://on-device-internals/'
    await page.goto(brokerUrl, { timeout: remainingTimeout() })
    if (new URL(page.url()).hostname === 'debug-webuis-disabled') {
      await page.goto('chrome://chrome-urls/', {
        timeout: remainingTimeout(),
      })
      await page
        .getByRole('button', {
          name: 'Enable internal debugging pages',
          exact: true,
        })
        .click({ timeout: remainingTimeout() })
      await page.goto(brokerUrl, { timeout: remainingTimeout() })
    }
    if (page.url() !== brokerUrl) {
      return undefined
    }
    const component = page.locator('on-device-internals-broker-state')
    await component.waitFor({ state: 'attached', timeout: remainingTimeout() })
    const state: unknown = await component.evaluate(async element => {
      if (
        !('getBrokerState_' in element) ||
        typeof element.getBrokerState_ !== 'function' ||
        !('state_' in element)
      ) {
        return undefined
      }
      await element.getBrokerState_()
      return element.state_
    })
    return sanitizeGemmaBroker(state)
  } finally {
    await page.close()
  }
}

async function readHistograms(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page)
  try {
    const histograms: NonNullable<ReturnType<typeof sanitizeGemmaHistograms>> =
      []
    for (const query of ['OnDeviceModel', 'ChildProcess']) {
      const data = sanitizeGemmaHistograms(
        await cdp.send('Browser.getHistograms', {
          query,
          delta: false,
        }),
      )
      if (!data) {
        return undefined
      }
      histograms.push(...data)
    }
    return histograms
  } finally {
    await cdp.detach()
  }
}

async function readPreferences(profile: string) {
  const text = await fs.readFile(
    new URL('./Local%20State', pathToFileURL(`${profile}/`)),
    'utf8',
  )
  const data: unknown = JSON.parse(text)
  return sanitizeGemmaPreferences(data)
}

async function captureChannel<T>(
  read: () => Promise<T | undefined>,
  save: (result: DiagnosticChannel<T>) => void,
) {
  try {
    const data = await read()
    save(
      data === undefined
        ? { status: 'unavailable' }
        : { status: 'captured', data },
    )
  } catch {
    save({ status: 'unavailable' })
  }
}

export async function collectGemmaDiagnostics(
  config: GemmaDiagnosticConfig,
): Promise<GemmaDiagnostics> {
  const options = { __proto__: undefined, ...config } as GemmaDiagnosticConfig
  const result: GemmaDiagnostics = {
    broker: { status: 'timed-out' },
    histograms: { status: 'timed-out' },
    preferences: { status: 'timed-out' },
  }
  if (!(options.timeoutMs > 0)) {
    return result
  }
  const timeoutMs = Math.min(10_000, options.timeoutMs)
  const pending = [
    captureChannel(
      () => readBroker(options.context, timeoutMs),
      data => {
        result.broker = data
      },
    ),
    captureChannel(
      () => readHistograms(options.context, options.page),
      data => {
        result.histograms = data
      },
    ),
    captureChannel(
      () => readPreferences(options.profile),
      data => {
        result.preferences = data
      },
    ),
  ]
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, timeoutMs)
    void Promise.allSettled(pending).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
  return { __proto__: null, ...result } as GemmaDiagnostics
}
