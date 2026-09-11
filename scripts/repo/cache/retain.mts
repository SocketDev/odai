import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'
import { isObject } from '@socketsecurity/lib-stable/objects/predicates'
import { uploadArtifact } from '../../fleet/artifact/client.mts'
import {
  cachePaths,
  exportGemmaCache,
  hashCacheFile,
  verifyCacheManifest,
} from './util.mts'
import type { CacheManifest } from './util.mts'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface GemmaReplayIdentity {
  browserVersion: string
  cpuOverride: boolean
  imageDigest: string
  sourceRun: string
}

export interface GemmaReplayMetadata extends GemmaReplayIdentity {
  architecture: 'x64'
  cacheManifestSha256: string
  createdAt: string
  expiresAt: string
  inferenceVerified: false
  model: 'gemma4'
  modelVersions: string[]
  platform: 'linux'
  schemaVersion: 1
}

export function gemmaReplayPaths(directory: string) {
  return {
    __proto__: null,
    metadata: path.join(directory, 'gemma-replay.json'),
    profile: path.join(directory, 'profile'),
  }
}

function assertReplayIdentity(identity: GemmaReplayIdentity): void {
  if (
    !/^\d+(?:\.\d+){3}$/.test(identity.browserVersion) ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.imageDigest) ||
    !/^[1-9]\d{0,19}$/.test(identity.sourceRun) ||
    typeof identity.cpuOverride !== 'boolean'
  ) {
    throw new Error(
      'Invalid Gemma replay identity. Where: replay metadata. Saw invalid browser, image, run or mode; wanted immutable Linux provenance. Fix: use the verified image and originating run.',
    )
  }
}

function replayModelVersions(manifest: CacheManifest): string[] {
  const versions = new Set<string>()
  for (const file of manifest.files) {
    // Match versioned Gemma weights beneath the component public-key digest.
    const match =
      /^OptGuideManifestModel\/[a-f0-9]{64}\/(\d+(?:\.\d+){3})\/weights\.bin$/.exec(
        file.path,
      )
    if (match && file.size > 0) {
      versions.add(match[1]!)
    }
  }
  if (versions.size === 0) {
    throw new Error(
      'Missing Gemma replay model. Where: exported cache manifest. Saw no versioned weights; wanted complete Gemma weights. Fix: finish native model provisioning before retention.',
    )
  }
  return [...versions].toSorted()
}

export async function prepareGemmaReplay(
  config: GemmaReplayIdentity & {
    destination: string
    nowMs?: number | undefined
    repositoryPrivate: unknown
    source: string
  },
): Promise<GemmaReplayMetadata> {
  const opts = { __proto__: null, ...config }
  assertReplayIdentity(opts)
  if (opts.repositoryPrivate !== true) {
    throw new Error(
      'Gemma replay retention requires private storage. Where: source repository. Saw public or unknown visibility; wanted a private repository. Fix: retain diagnostics only in the private producer repository.',
    )
  }
  const nowMs = opts.nowMs ?? Date.now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError('Invalid Gemma replay creation time')
  }
  const paths = gemmaReplayPaths(opts.destination)
  await fs.mkdir(opts.destination, { mode: 0o700 })
  const manifest = await exportGemmaCache(opts.source, paths.profile)
  const metadata: GemmaReplayMetadata = {
    architecture: 'x64',
    browserVersion: opts.browserVersion,
    cacheManifestSha256: await hashCacheFile(
      cachePaths(paths.profile).manifest,
    ),
    cpuOverride: opts.cpuOverride,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + RETENTION_MS).toISOString(),
    imageDigest: opts.imageDigest,
    inferenceVerified: false,
    model: 'gemma4',
    modelVersions: replayModelVersions(manifest),
    platform: 'linux',
    schemaVersion: 1,
    sourceRun: opts.sourceRun,
  }
  await fs.writeFile(paths.metadata, JSON.stringify(metadata), {
    flag: 'wx',
    mode: 0o600,
  })
  await verifyGemmaReplay({ ...opts, directory: opts.destination, nowMs })
  return metadata
}

async function assertReplayFiles(
  directory: string,
  manifest: CacheManifest,
): Promise<void> {
  const allowed = new Set([
    'gemma-replay.json',
    'profile/Local State',
    'profile/odai-cache.html',
    'profile/odai-cache-manifest.json',
    'profile/odai-cache-profile.json',
    ...manifest.files.map(file => `profile/${file.path}`),
  ])
  const directories = new Set<string>()
  for (const file of allowed) {
    const segments = normalizePath(file).split('/')
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'))
    }
  }
  let count = 0
  async function visit(relative: string): Promise<void> {
    if (++count > 10_000) {
      throw new Error('Gemma replay contains too many entries')
    }
    const absolute = path.join(directory, relative)
    // oxlint-disable-next-line socket/prefer-exists-sync -- file metadata
    const info = await fs.lstat(absolute)
    if (info.isDirectory() && directories.has(relative)) {
      for (const name of await fs.readdir(absolute)) {
        await visit(normalizePath(path.join(relative, name)))
      }
    } else if (!info.isFile() || !allowed.has(relative)) {
      throw new Error('Gemma replay contains files outside its export manifest')
    }
  }
  for (const name of await fs.readdir(directory)) {
    await visit(normalizePath(name))
  }
}

function replayIdentity(value: unknown, identity: GemmaReplayIdentity) {
  if (
    !isObject(value) ||
    value['schemaVersion'] !== 1 ||
    value['inferenceVerified'] !== false ||
    value['imageDigest'] !== identity.imageDigest ||
    value['browserVersion'] !== identity.browserVersion ||
    value['sourceRun'] !== identity.sourceRun ||
    value['cpuOverride'] !== identity.cpuOverride ||
    value['platform'] !== 'linux' ||
    value['architecture'] !== 'x64' ||
    value['model'] !== 'gemma4' ||
    typeof value['createdAt'] !== 'string' ||
    typeof value['expiresAt'] !== 'string'
  ) {
    throw new Error(
      'Gemma replay identity mismatch. Where: retained artifact. Saw missing or incompatible provenance; wanted the requested browser, image, mode and run. Fix: restore the matching experimental artifact.',
    )
  }
  return {
    __proto__: null,
    createdAt: value['createdAt'],
    expiresAt: value['expiresAt'],
  }
}

function assertReplayLifetime(
  createdAt: string,
  expiresAt: string,
  nowMs: number,
): void {
  const createdMs = Date.parse(createdAt)
  const expiresMs = Date.parse(expiresAt)
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isFinite(createdMs) ||
    expiresMs - createdMs !== RETENTION_MS ||
    createdMs > nowMs ||
    nowMs >= expiresMs
  ) {
    throw new Error(
      'Gemma replay has expired or invalid timestamps. Where: retained artifact. Saw an invalid seven-day lifetime; wanted a current artifact. Fix: provision and retain a new cache.',
    )
  }
}

export async function verifyGemmaReplay(
  config: GemmaReplayIdentity & {
    directory: string
    nowMs?: number | undefined
  },
): Promise<GemmaReplayMetadata> {
  const opts = { __proto__: null, ...config }
  assertReplayIdentity(opts)
  const paths = gemmaReplayPaths(opts.directory)
  // oxlint-disable-next-line socket/prefer-exists-sync -- file metadata
  const info = await fs.lstat(paths.metadata)
  if (!info.isFile() || info.size > 16 * 1024) {
    throw new Error('Invalid Gemma replay metadata file')
  }
  const value: unknown = JSON.parse(await fs.readFile(paths.metadata, 'utf8'))
  const nowMs = opts.nowMs ?? Date.now()
  const { createdAt, expiresAt } = replayIdentity(value, opts)
  assertReplayLifetime(createdAt, expiresAt, nowMs)
  const manifest = await verifyCacheManifest(paths.profile)
  await assertReplayFiles(opts.directory, manifest)
  const expected: GemmaReplayMetadata = {
    architecture: 'x64',
    browserVersion: opts.browserVersion,
    cacheManifestSha256: await hashCacheFile(
      cachePaths(paths.profile).manifest,
    ),
    cpuOverride: opts.cpuOverride,
    createdAt,
    expiresAt,
    imageDigest: opts.imageDigest,
    inferenceVerified: false,
    model: 'gemma4',
    modelVersions: replayModelVersions(manifest),
    platform: 'linux',
    schemaVersion: 1,
    sourceRun: opts.sourceRun,
  }
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(
      'Gemma replay metadata changed. Where: retained artifact. Saw different hashes or fields; wanted the exported manifest. Fix: restore the original immutable artifact.',
    )
  }
  return expected
}

export async function uploadGemmaReplay(
  config: GemmaReplayIdentity & {
    destination: string
    repositoryPrivate: unknown
    source: string
  },
) {
  const metadata = await prepareGemmaReplay(config)
  const name = `gemma-replay-${config.cpuOverride ? 'cpu' : 'default'}-${metadata.sourceRun}`
  const artifactId = await uploadArtifact(name, [config.destination], {
    retentionDays: 7,
  })
  return { __proto__: null, artifactId, name, metadata }
}
