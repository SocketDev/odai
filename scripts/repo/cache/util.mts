import crypto from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'
import { isObject } from '@socketsecurity/lib-stable/objects/predicates'

const CACHE_BRIDGE_HTML =
  '<!doctype html><title>Odai cache verification</title>'
export const GEMMA_FLAG = 'gemma4-for-built-in-ai@1'
export const MODEL_DIRECTORIES = [
  'OptGuideManifestModel',
  'OptGuideOnDeviceClassifierModel',
  'OptimizationGuideModelsManifest',
  'optimization_guide_model_store',
] as const
const RUNTIME_CACHE_FILES = new Set([
  'adapter_cache.bin',
  'cache.bin',
  'encoder_cache.bin',
  'program_cache.bin',
  'program_cache.bin.dawn_version',
])

export interface CacheFile {
  path: string
  sha256: string
  size: number
}

export interface CacheManifest {
  files: CacheFile[]
  model: 'gemma4'
  schemaVersion: 1
}

type GemmaAssetEntry = readonly [
  string,
  { asset_id: 'gemma4_component'; requested_version: string },
]

export function cachePaths(directory: string) {
  return {
    __proto__: null,
    bridge: path.join(directory, 'odai-cache.html'),
    manifest: path.join(directory, 'odai-cache-manifest.json'),
    marker: path.join(directory, 'odai-cache-profile.json'),
    state: path.join(directory, 'Local State'),
  }
}

export function gemmaState(
  options?:
    | {
        assetLedger?: readonly GemmaAssetEntry[] | undefined
        nowMs?: number | undefined
      }
    | undefined,
) {
  const opts = { __proto__: null, ...options } as NonNullable<typeof options>
  const nowMs = opts.nowMs ?? Date.now()
  const chromeTime = String((nowMs + 11_644_473_600_000) * 1000)
  return {
    __proto__: null,
    browser: {
      enabled_labs_experiments: [GEMMA_FLAG, 'prompt-api@1'],
    },
    optimization_guide: {
      model_execution: {
        last_usage_by_feature: { prompt_api_gemma4: chromeTime },
        ...(opts.assetLedger?.length
          ? { manifest_asset_ledger: Object.fromEntries(opts.assetLedger) }
          : {}),
      },
      on_device: { last_time_eligible_for_download: chromeTime },
    },
  }
}

function gemmaAssetLedger(
  state: unknown,
  files: readonly CacheFile[],
): GemmaAssetEntry[] {
  const guide = isObject(state) ? state['optimization_guide'] : undefined
  const execution = isObject(guide) ? guide['model_execution'] : undefined
  const ledger = isObject(execution)
    ? execution['manifest_asset_ledger']
    : undefined
  if (!isObject(ledger) || Array.isArray(ledger)) {
    return []
  }
  const entries: GemmaAssetEntry[] = []
  for (const file of files) {
    // Match weights beneath a component's SHA256 public key and four-part version.
    const match =
      /^OptGuideManifestModel\/([a-f0-9]{64})\/(\d+(?:\.\d+){3})\/weights\.bin$/.exec(
        file.path,
      )
    if (!match || file.size <= 0) {
      continue
    }
    const key = match[1]!
    const version = match[2]!
    const entry: unknown = ledger[key]
    if (
      isObject(entry) &&
      entry['asset_id'] === 'gemma4_component' &&
      entry['requested_version'] === version
    ) {
      entries.push([
        key,
        {
          asset_id: 'gemma4_component',
          requested_version: version,
        },
      ])
    }
  }
  return entries
}

export async function initializeCacheProfile(directory: string): Promise<void> {
  const paths = cachePaths(directory)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const entries = await fs.readdir(directory)
  if (entries.length !== 0) {
    await assertCacheProfile(directory)
    return
  }
  await fs.writeFile(
    paths.marker,
    JSON.stringify({ model: 'gemma4', schemaVersion: 1 }),
    { flag: 'wx', mode: 0o600 },
  )
  await fs.writeFile(paths.state, JSON.stringify(gemmaState()), {
    flag: 'wx',
    mode: 0o600,
  })
  await fs.writeFile(paths.bridge, CACHE_BRIDGE_HTML, {
    flag: 'wx',
    mode: 0o600,
  })
}

export async function assertCacheProfile(directory: string): Promise<void> {
  const paths = cachePaths(directory)
  if (
    // oxlint-disable-next-line socket/prefer-exists-sync -- metadata
    !(await fs.lstat(directory)).isDirectory() ||
    // oxlint-disable-next-line socket/prefer-exists-sync -- metadata
    !(await fs.lstat(paths.marker)).isFile()
  ) {
    throw new Error(
      `Invalid odai profile at ${directory}. Saw a linked or non-regular profile marker; expected an owned directory and marker. Provision a new empty directory.`,
    )
  }
  const marker: unknown = JSON.parse(await fs.readFile(paths.marker, 'utf8'))
  if (
    typeof marker !== 'object' ||
    marker === null ||
    !('model' in marker) ||
    marker.model !== 'gemma4' ||
    !('schemaVersion' in marker) ||
    marker.schemaVersion !== 1
  ) {
    throw new Error(
      `Invalid odai profile at ${directory}. Saw an unrecognized marker; expected a dedicated Gemma profile. Provision a new empty directory.`,
    )
  }
  if (!(await fs.readdir(directory)).includes('SingletonLock')) {
    return
  }
  throw new Error(
    `Odai profile is active at ${directory}. Saw Chrome's profile lock; expected a closed browser. Close this profile before copying it.`,
  )
}

export async function hashCacheFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export async function inventoryCache(directory: string): Promise<CacheFile[]> {
  const files: CacheFile[] = []
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(directory, relative)
    // oxlint-disable-next-line socket/prefer-exists-sync -- metadata check
    const stat = await fs.lstat(absolute)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(
        `Invalid cache entry at ${absolute}. Saw a link or special file; expected regular model data. Remove that entry before export.`,
      )
    }
    if (stat.isDirectory()) {
      const names = (await fs.readdir(absolute)).toSorted()
      for (let index = 0, { length } = names; index < length; index += 1) {
        await visit(path.join(relative, names[index]!))
      }
      return
    }
    if (RUNTIME_CACHE_FILES.has(path.basename(relative))) {
      return
    }
    files.push({
      path: normalizePath(relative),
      sha256: await hashCacheFile(absolute),
      size: stat.size,
    })
  }
  const entries = new Set(await fs.readdir(directory))
  for (const name of MODEL_DIRECTORIES) {
    if (!entries.has(name)) {
      continue
    }
    await visit(name)
  }
  if (
    !files.some(file => file.path.startsWith('OptGuideManifestModel/')) ||
    !files.some(file => /(?:^|\/)prompt_gemma4[^/]*\.binarypb$/.test(file.path))
  ) {
    throw new Error(
      `Gemma cache is incomplete at ${directory}. Saw no complete model and prompt configuration; expected both. Finish provisioning Gemma before export.`,
    )
  }
  return files
}

export async function exportGemmaCache(
  source: string,
  destination: string,
): Promise<CacheManifest> {
  await assertCacheProfile(source)
  const files = await inventoryCache(source)
  const sourceState = cachePaths(source).state
  // oxlint-disable-next-line socket/prefer-exists-sync -- metadata
  if (!(await fs.lstat(sourceState)).isFile()) {
    throw new Error(
      `Invalid cache state at ${source}. Saw a linked or special file; expected regular browser settings. Export a closed dedicated profile.`,
    )
  }
  const state: unknown = JSON.parse(await fs.readFile(sourceState, 'utf8'))
  const assetLedger = gemmaAssetLedger(state, files)
  const disk = await fs.statfs(path.dirname(destination))
  const copyBytes = files.reduce((total, file) => total + file.size, 1024 ** 2)
  if (disk.bavail * disk.bsize < copyBytes) {
    throw new Error(
      `Cache export has insufficient disk space at ${destination}. Saw less than ${copyBytes} available bytes; expected room for the complete cache. Free disk space before exporting.`,
    )
  }
  await fs.mkdir(destination, { mode: 0o700 })
  await initializeCacheProfile(destination)
  for (const file of files) {
    const target = path.join(destination, file.path)
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await fs.copyFile(
      path.join(source, file.path),
      target,
      constants.COPYFILE_FICLONE,
    )
  }
  const copied = await inventoryCache(destination)
  if (JSON.stringify(copied) !== JSON.stringify(files)) {
    throw new Error(
      'Cache changed during export. Saw different hashes; expected a stable closed profile. Close Chrome and retry with a new destination.',
    )
  }
  await fs.writeFile(
    cachePaths(destination).state,
    JSON.stringify(gemmaState({ assetLedger })),
    { mode: 0o600 },
  )
  const manifest: CacheManifest = { files, model: 'gemma4', schemaVersion: 1 }
  await fs.writeFile(
    cachePaths(destination).manifest,
    JSON.stringify(manifest, null, 2),
    { flag: 'wx', mode: 0o600 },
  )
  return manifest
}

export async function verifyCacheManifest(
  directory: string,
): Promise<CacheManifest> {
  await assertCacheProfile(directory)
  const files = await inventoryCache(directory)
  await assertExportState(directory, files)
  const value: unknown = JSON.parse(
    await fs.readFile(cachePaths(directory).manifest, 'utf8'),
  )
  const actual: CacheManifest = {
    files,
    model: 'gemma4',
    schemaVersion: 1,
  }
  if (JSON.stringify(value) !== JSON.stringify(actual)) {
    throw new Error(
      `Cache integrity failed at ${directory}. Saw changed files or metadata; expected the exported hashes. Export a fresh closed profile.`,
    )
  }
  return actual
}

async function assertExportState(
  directory: string,
  files: readonly CacheFile[],
): Promise<void> {
  const paths = cachePaths(directory)
  if (
    // oxlint-disable-next-line socket/prefer-exists-sync -- metadata
    !(await fs.lstat(paths.state)).isFile() ||
    // oxlint-disable-next-line socket/prefer-exists-sync -- metadata
    !(await fs.lstat(paths.bridge)).isFile()
  ) {
    throw new Error(
      `Invalid cache profile files at ${directory}. Saw links or special files; expected generated regular files. Export a fresh profile.`,
    )
  }
  const state: unknown = JSON.parse(await fs.readFile(paths.state, 'utf8'))
  const guide =
    isObject(state) && isObject(state['optimization_guide'])
      ? state['optimization_guide']
      : {}
  const device = isObject(guide['on_device']) ? guide['on_device'] : {}
  const timestamp = device['last_time_eligible_for_download']
  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) {
    throw new Error(
      `Invalid cache activation data at ${directory}. Saw a missing or malformed timestamp; expected clean generated settings. Export a fresh profile.`,
    )
  }
  const expected = gemmaState({
    assetLedger: gemmaAssetLedger(state, files),
    nowMs: 0,
  })
  expected.optimization_guide.model_execution.last_usage_by_feature.prompt_api_gemma4 =
    timestamp
  expected.optimization_guide.on_device.last_time_eligible_for_download =
    timestamp
  if (
    JSON.stringify(state) !== JSON.stringify(expected) ||
    (await fs.readFile(paths.bridge, 'utf8')) !== CACHE_BRIDGE_HTML
  ) {
    throw new Error(
      `Unexpected cache profile data at ${directory}. Saw settings or page content outside the export allowlist; expected only generated activation data. Export a fresh profile.`,
    )
  }
}
