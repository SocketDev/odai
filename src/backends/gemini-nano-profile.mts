/**
 * @file Node-side provisioning for the gemini-nano-headless bridge: Chrome
 *   executable resolution, model-component discovery, copy-on-write cloning
 *   of the system Chrome model into a locai-owned profile, and the Local
 *   State activation seed. The recipe is empirical, verified against Chrome
 *   150: labs flags via `browser.enabled_labs_experiments`,
 *   `MODEL_EXECUTION_FEATURE_PROMPT_API` (id 6) marked recently used, and the
 *   system profile's on-device prefs plus component registration carried
 *   over. The live Chrome profile is only ever read. All node: imports are
 *   lazy so this module stays loadable from the browser bundle.
 */

import type * as childProcessNs from 'node:child_process'
import type * as fsNs from 'node:fs'
import type * as fspNs from 'node:fs/promises'
import type * as osNs from 'node:os'
import type * as pathNs from 'node:path'

export const LOCAI_CHROME_ENV_VAR = 'LOCAI_CHROME'
export const LOCAI_NANO_ALLOW_DOWNLOAD_ENV_VAR = 'LOCAI_NANO_ALLOW_DOWNLOAD'
export const LOCAI_NANO_USER_DATA_DIR_ENV_VAR = 'LOCAI_NANO_USER_DATA_DIR'

/**
 * Directory carrying the 4 GB foundational model component in a Chrome
 * user-data dir.
 */
export const MODEL_COMPONENT_DIR = 'OptGuideOnDeviceModel'

export const BRIDGE_PAGE_FILENAME = 'locai-bridge.html'

/**
 * Chrome://flags selections, persisted the same way the flags UI does.
 * `optimization-guide-on-device-model@2` = Enabled BypassPerfRequirement,
 * `prompt-api-for-gemini-nano@1` = Enabled.
 */
const ENABLED_LABS_EXPERIMENTS = [
  'optimization-guide-on-device-model@2',
  'prompt-api-for-gemini-nano@1',
]

/**
 * Component-updater id of the Optimization Guide On Device Model.
 */
const ON_DEVICE_COMPONENT_ID = 'fklghjjljmnfjoepjmlobpekiapffcja'

/**
 * Supplementary model dirs cloned alongside the foundational component when
 * present: the text-safety and adaptation model stores.
 */
const OPTIONAL_MODEL_DIRS = [
  'optimization_guide_model_store',
  'OptGuideOnDeviceClassifierModel',
]

/**
 * `MODEL_EXECUTION_FEATURE_PROMPT_API` in Chrome's ModelExecutionFeature
 * proto enum. Seeding this key in `last_usage_by_feature` is what makes the
 * adaptation loader engage for the Prompt API; feature 15 (scam detection) is
 * what most real profiles carry instead.
 */
const PROMPT_API_FEATURE_ID = '6'

const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000

export interface BridgeConfigInput {
  allowDownload?: boolean | undefined
  chromePath?: string | undefined
  env?: Record<string, string | undefined> | undefined
  systemChromeUserDataDir?: string | undefined
  userDataDir?: string | undefined
}

export interface ModelSource {
  kind: 'download' | 'profile' | 'system'
  reason?: string | undefined
}

export interface NodeDeps {
  childProcess: typeof childProcessNs
  fs: typeof fsNs
  fsp: typeof fspNs
  os: typeof osNs
  path: typeof pathNs
}

export interface ResolvedBridgeConfig {
  allowDownload: boolean
  chromePath: string | undefined
  chromePathCandidates: string[]
  systemChromeUserDataDir: string
  userDataDir: string
}

export interface SystemLocalStateExtract {
  onDevice: Record<string, unknown>
  updaterApp: unknown
}

let nodeDepsPromise: Promise<NodeDeps> | undefined

export function buildLocalStateSeed(
  existing: Record<string, unknown>,
  system: SystemLocalStateExtract,
): Record<string, unknown> {
  const now = chromeNowMicros()
  const optimizationGuide = {
    ...(existing['optimization_guide'] as Record<string, unknown> | undefined),
    model_execution: {
      last_usage_by_feature: { [PROMPT_API_FEATURE_ID]: now },
    },
    on_device: { ...system.onDevice, last_time_eligible_for_download: now },
  }
  const browser = {
    ...(existing['browser'] as Record<string, unknown> | undefined),
    enabled_labs_experiments: ENABLED_LABS_EXPERIMENTS,
  }
  const seeded: Record<string, unknown> = {
    ...existing,
    browser,
    optimization_guide: optimizationGuide,
  }
  if (system.updaterApp !== undefined) {
    const updateclientdata = (existing['updateclientdata'] ?? {}) as {
      apps?: Record<string, unknown> | undefined
    }
    seeded['updateclientdata'] = {
      ...updateclientdata,
      apps: {
        ...updateclientdata.apps,
        [ON_DEVICE_COMPONENT_ID]: system.updaterApp,
      },
    }
  }
  return seeded
}

export function chromeMissingReason(config: ResolvedBridgeConfig): string {
  return (
    'Google Chrome not found; looked at ' +
    `${config.chromePathCandidates.join(', ')}. Install Google Chrome or ` +
    `point ${LOCAI_CHROME_ENV_VAR} at the executable. Chromium builds do ` +
    'not work: they lack optimization_guide_internal and cannot run Nano.'
  )
}

/**
 * Microseconds since the Windows epoch, the unit Chrome prefs store
 * timestamps in.
 */
export function chromeNowMicros(): string {
  return String((Date.now() + WINDOWS_EPOCH_OFFSET_MS) * 1000)
}

export function chromePathCandidates(
  platform: string,
  env: Record<string, string | undefined>,
  homeDir: string,
): string[] {
  if (platform === 'darwin') {
    const suffix = 'Google Chrome.app/Contents/MacOS/Google Chrome'
    return [`/Applications/${suffix}`, `${homeDir}/Applications/${suffix}`]
  }
  if (platform === 'win32') {
    const suffix = 'Google\\Chrome\\Application\\chrome.exe'
    return [env['LOCALAPPDATA'], env['PROGRAMFILES'], env['PROGRAMFILES(X86)']]
      .filter(base => base !== undefined && base !== '')
      .map(base => `${base}\\${suffix}`)
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
  ]
}

/**
 * Copy-on-write directory clone: `cp -c` (APFS clonefile) on macOS,
 * `cp --reflink=auto` on Linux, `fs.cp` elsewhere or on failure. The 4 GB
 * model clone is instant and free on APFS/btrfs/XFS.
 */
export async function cloneDir(source: string, target: string): Promise<void> {
  const { childProcess, fsp } = await loadNodeDeps()
  const platform = process.platform
  const args =
    platform === 'darwin'
      ? ['-R', '-c', source, target]
      : platform === 'linux'
        ? ['-R', '--reflink=auto', source, target]
        : undefined
  if (args !== undefined) {
    const copied = await new Promise<boolean>(resolve => {
      childProcess.execFile('cp', args, error => resolve(error === null))
    })
    if (copied) {
      return
    }
  }
  await fsp.cp(source, target, { recursive: true })
}

export function defaultBridgeUserDataDir(
  env: Record<string, string | undefined>,
  homeDir: string,
  path: NodeDeps['path'],
): string {
  const cacheHome = env['XDG_CACHE_HOME'] ?? path.join(homeDir, '.cache')
  return path.join(cacheHome, 'locai', 'gemini-nano-headless')
}

/**
 * Materialize the locai-owned bridge profile: clone the model component dirs
 * from the system Chrome profile when needed, and (re)seed the Local State
 * activation prefs. Returns the bridge page path — a file:// document,
 * because the Prompt API only exists in secure contexts. The system profile
 * is only ever read.
 */
export async function ensureBridgeProfile(
  config: ResolvedBridgeConfig,
  source: ModelSource,
): Promise<string> {
  const { fs, fsp, path } = await loadNodeDeps()
  await fsp.mkdir(config.userDataDir, { recursive: true })
  if (source.kind === 'system') {
    for (const dir of [MODEL_COMPONENT_DIR, ...OPTIONAL_MODEL_DIRS]) {
      const from = path.join(config.systemChromeUserDataDir, dir)
      const to = path.join(config.userDataDir, dir)
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        await cloneDir(from, to)
      }
    }
  }
  const localStatePath = path.join(config.userDataDir, 'Local State')
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await fsp.readFile(localStatePath, 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    // First launch of this profile; start from an empty Local State.
  }
  const system =
    source.kind === 'download'
      ? { onDevice: {}, updaterApp: undefined }
      : await readSystemLocalState(config.systemChromeUserDataDir)
  await fsp.writeFile(
    localStatePath,
    JSON.stringify(buildLocalStateSeed(existing, system)),
  )
  const bridgePagePath = path.join(config.userDataDir, BRIDGE_PAGE_FILENAME)
  await fsp.writeFile(
    bridgePagePath,
    '<!doctype html><title>locai gemini-nano-headless bridge</title>',
  )
  return bridgePagePath
}

export function envFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

export async function findModelSource(
  config: ResolvedBridgeConfig,
): Promise<ModelSource> {
  const { fs, path } = await loadNodeDeps()
  if (fs.existsSync(path.join(config.userDataDir, MODEL_COMPONENT_DIR))) {
    return { kind: 'profile' }
  }
  if (
    fs.existsSync(
      path.join(config.systemChromeUserDataDir, MODEL_COMPONENT_DIR),
    )
  ) {
    return { kind: 'system' }
  }
  if (config.allowDownload) {
    return { kind: 'download' }
  }
  return {
    kind: 'download',
    reason:
      `no Gemini Nano model component: neither the bridge profile at ` +
      `${config.userDataDir} nor the system Chrome profile at ` +
      `${config.systemChromeUserDataDir} has ${MODEL_COMPONENT_DIR}, and ` +
      `downloads are off. Let Chrome download the model once, or set ` +
      `${LOCAI_NANO_ALLOW_DOWNLOAD_ENV_VAR}=1 to fetch it here (CI mode).`,
  }
}

export function isNodeRuntime(): boolean {
  return (
    typeof process !== 'undefined' && typeof process.versions?.node === 'string'
  )
}

export async function loadNodeDeps(): Promise<NodeDeps> {
  nodeDepsPromise ??= (async () => ({
    childProcess: await import('node:child_process'),
    fs: await import('node:fs'),
    fsp: await import('node:fs/promises'),
    os: await import('node:os'),
    path: await import('node:path'),
  }))()
  return await nodeDepsPromise
}

export function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(prefixed)}`
}

export async function readSystemLocalState(
  systemDir: string,
): Promise<SystemLocalStateExtract> {
  const { fsp, path } = await loadNodeDeps()
  try {
    const raw = await fsp.readFile(path.join(systemDir, 'Local State'), 'utf8')
    const parsed = JSON.parse(raw) as {
      optimization_guide?:
        | { on_device?: Record<string, unknown> | undefined }
        | undefined
      updateclientdata?:
        | { apps?: Record<string, unknown> | undefined }
        | undefined
    }
    return {
      onDevice: parsed.optimization_guide?.on_device ?? {},
      updaterApp: parsed.updateclientdata?.apps?.[ON_DEVICE_COMPONENT_ID],
    }
  } catch {
    return { onDevice: {}, updaterApp: undefined }
  }
}

export async function resolveBridgeConfig(
  options: BridgeConfigInput,
): Promise<ResolvedBridgeConfig> {
  const opts = { __proto__: null, ...options } as BridgeConfigInput
  const { fs, os, path } = await loadNodeDeps()
  const env = opts.env ?? (typeof process === 'undefined' ? {} : process.env)
  const homeDir = os.homedir()
  const platform = process.platform
  const candidates =
    opts.chromePath !== undefined
      ? [opts.chromePath]
      : env[LOCAI_CHROME_ENV_VAR] !== undefined &&
          env[LOCAI_CHROME_ENV_VAR] !== ''
        ? [env[LOCAI_CHROME_ENV_VAR]]
        : chromePathCandidates(platform, env, homeDir)
  const chromePath = candidates.find(candidate => fs.existsSync(candidate))
  return {
    allowDownload:
      opts.allowDownload ?? envFlag(env[LOCAI_NANO_ALLOW_DOWNLOAD_ENV_VAR]),
    chromePath,
    chromePathCandidates: candidates,
    systemChromeUserDataDir:
      opts.systemChromeUserDataDir ??
      systemChromeUserDataDirFor(platform, env, homeDir),
    userDataDir:
      opts.userDataDir ??
      (env[LOCAI_NANO_USER_DATA_DIR_ENV_VAR] !== undefined &&
      env[LOCAI_NANO_USER_DATA_DIR_ENV_VAR] !== ''
        ? env[LOCAI_NANO_USER_DATA_DIR_ENV_VAR]
        : defaultBridgeUserDataDir(env, homeDir, path)),
  }
}

export function systemChromeUserDataDirFor(
  platform: string,
  env: Record<string, string | undefined>,
  homeDir: string,
): string {
  if (platform === 'darwin') {
    return `${homeDir}/Library/Application Support/Google/Chrome`
  }
  if (platform === 'win32') {
    return `${env['LOCALAPPDATA'] ?? homeDir}\\Google\\Chrome\\User Data`
  }
  const configHome = env['XDG_CONFIG_HOME'] ?? `${homeDir}/.config`
  return `${configHome}/google-chrome`
}
