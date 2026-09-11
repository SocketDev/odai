import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { uploadArtifact } from '../../../../scripts/fleet/artifact/client.mts'
import {
  gemmaReplayPaths,
  prepareGemmaReplay,
  uploadGemmaReplay,
  verifyGemmaReplay,
} from '../../../../scripts/repo/cache/retain.mts'
import { initializeCacheProfile } from '../../../../scripts/repo/cache/util.mts'

vi.mock(import('../../../../scripts/fleet/artifact/client.mts'), () => ({
  uploadArtifact: vi.fn().mockResolvedValue(42),
}))

const roots: string[] = []
const identity = {
  browserVersion: '154.0.8037.0',
  cpuOverride: true,
  imageDigest: `sha256:${'ab'.repeat(32)}`,
  sourceRun: '12345',
}
const nowMs = Date.UTC(2026, 8, 11)

async function replayFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-replay-'))
  roots.push(root)
  const source = path.join(root, 'source')
  const destination = path.join(root, 'replay')
  await initializeCacheProfile(source)
  const weightPath = `OptGuideManifestModel/${'ab'.repeat(32)}/2026.8.7.929/weights.bin`
  for (const file of [
    weightPath,
    'OptimizationGuideModelsManifest/version/prompt_gemma4_solution_config.binarypb',
  ]) {
    const target = path.join(source, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'model fixture')
  }
  const config = {
    ...identity,
    source,
    destination,
    repositoryPrivate: true,
    nowMs,
  }
  return { config, weightPath }
}

afterEach(async () => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) {
    await safeDelete(root)
  }
})

test('retains a sanitized experimental cache with immutable identity and seven-day expiry', async () => {
  const { config } = await replayFixture()
  await fs.writeFile(path.join(config.source, 'History'), 'private fixture')
  const metadata = await prepareGemmaReplay(config)
  expect(metadata).toMatchObject({
    ...identity,
    inferenceVerified: false,
    modelVersions: ['2026.8.7.929'],
  })
  expect(Date.parse(metadata.expiresAt) - Date.parse(metadata.createdAt)).toBe(
    7 * 86_400_000,
  )
  const verified = await verifyGemmaReplay({
    ...identity,
    directory: config.destination,
    nowMs,
  })
  expect(verified).toEqual(metadata)
  expect(
    await fs.readdir(gemmaReplayPaths(config.destination).profile),
  ).not.toContain('History')
})

test('refuses public retention before creating an export or calling upload', async () => {
  const { config } = await replayFixture()
  await expect(
    uploadGemmaReplay({ ...config, repositoryPrivate: false }),
  ).rejects.toThrow()
  expect(uploadArtifact).not.toHaveBeenCalled()
  expect(existsSync(config.destination)).toBe(false)
})

test('uploads only the generated export with enforced retention', async () => {
  const { config } = await replayFixture()
  const result = await uploadGemmaReplay(config)
  expect(result.artifactId).toBe(42)
  expect(result.metadata.inferenceVerified).toBe(false)
  expect(uploadArtifact).toHaveBeenCalledWith(
    'gemma-replay-cpu-12345',
    [config.destination],
    { retentionDays: 7 },
  )
})

test('propagates interrupted upload without a success receipt', async () => {
  const { config } = await replayFixture()
  vi.mocked(uploadArtifact).mockRejectedValueOnce(new Error('upload fixture'))
  await expect(uploadGemmaReplay(config)).rejects.toThrow()
})

test.each([
  ['browserVersion', '153.0.0.0'],
  ['imageDigest', `sha256:${'cd'.repeat(32)}`],
  ['sourceRun', '98765'],
  ['cpuOverride', false],
] as const)('rejects incompatible %s', async (key, value) => {
  const { config } = await replayFixture()
  await prepareGemmaReplay(config)
  await expect(
    verifyGemmaReplay({
      ...identity,
      [key]: value,
      directory: config.destination,
      nowMs,
    }),
  ).rejects.toThrow()
})

test.each([nowMs - 1, nowMs + 7 * 86_400_000])(
  'rejects future or expired metadata at %s',
  async clock => {
    const { config } = await replayFixture()
    await prepareGemmaReplay(config)
    await expect(
      verifyGemmaReplay({
        ...identity,
        directory: config.destination,
        nowMs: clock,
      }),
    ).rejects.toThrow()
  },
)

test('rejects tampered model bytes', async () => {
  const { config, weightPath } = await replayFixture()
  await prepareGemmaReplay(config)
  await fs.appendFile(
    path.join(gemmaReplayPaths(config.destination).profile, weightPath),
    'changed',
  )
  await expect(
    verifyGemmaReplay({ ...identity, directory: config.destination, nowMs }),
  ).rejects.toThrow()
})

test.each(['inferenceVerified', 'cacheManifestSha256', 'extra'])(
  'rejects altered %s metadata',
  async field => {
    const { config } = await replayFixture()
    const metadata = await prepareGemmaReplay(config)
    await fs.writeFile(
      gemmaReplayPaths(config.destination).metadata,
      JSON.stringify({ ...metadata, [field]: true }),
    )
    await expect(
      verifyGemmaReplay({ ...identity, directory: config.destination, nowMs }),
    ).rejects.toThrow()
  },
)

test('rejects browser state outside the manifest', async () => {
  const { config } = await replayFixture()
  await prepareGemmaReplay(config)
  await fs.writeFile(
    path.join(gemmaReplayPaths(config.destination).profile, 'History'),
    'unexpected state',
  )
  await expect(
    verifyGemmaReplay({ ...identity, directory: config.destination, nowMs }),
  ).rejects.toThrow()
})

test('rejects symlinked metadata', async () => {
  const { config } = await replayFixture()
  await prepareGemmaReplay(config)
  const metadata = gemmaReplayPaths(config.destination).metadata
  await fs.rename(metadata, `${metadata}.copy`)
  await fs.symlink(`${metadata}.copy`, metadata)
  await expect(
    verifyGemmaReplay({ ...identity, directory: config.destination, nowMs }),
  ).rejects.toThrow()
})

test.each([
  { sourceRun: 'not-a-run' },
  { browserVersion: 'beta' },
  { imageDigest: 'mutable-image' },
  { nowMs: Number.NaN },
])('rejects invalid provenance before export: %j', async invalid => {
  const { config } = await replayFixture()
  await expect(prepareGemmaReplay({ ...config, ...invalid })).rejects.toThrow()
  expect(existsSync(config.destination)).toBe(false)
})
