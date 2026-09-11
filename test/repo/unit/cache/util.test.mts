import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'

import {
  assertCacheProfile,
  cachePaths,
  exportGemmaCache,
  gemmaState,
  initializeCacheProfile,
  inventoryCache,
  verifyCacheManifest,
} from '../../../../scripts/repo/cache/util.mts'

const roots: string[] = []

async function cacheFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'odai-cache-'))
  roots.push(root)
  const source = path.join(root, 'source')
  await initializeCacheProfile(source)
  for (const file of [
    'OptGuideManifestModel/model/version/weights.bin',
    'OptimizationGuideModelsManifest/version/prompt_gemma4_solution_config.binarypb',
  ]) {
    const target = path.join(source, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'model fixture')
  }
  return { root, source }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await safeDelete(root)
  }
})

test('uses the supplied clock for Chrome model eligibility timestamps', () => {
  const state = gemmaState({ nowMs: 0 })
  expect(
    state.optimization_guide.on_device.last_time_eligible_for_download,
  ).toBe('11644473600000000')
  expect(
    state.optimization_guide.model_execution.last_usage_by_feature
      .prompt_api_gemma4,
  ).toBe('11644473600000000')
})

test('does not activate Nano while preparing Gemma', () => {
  const state = gemmaState({ nowMs: 0 })
  expect(state.browser.enabled_labs_experiments).not.toContain(
    'prompt-api-for-gemini-nano@1',
  )
  expect(
    state.optimization_guide.model_execution.last_usage_by_feature,
  ).not.toHaveProperty('6')
})

test('exports only model files and a sanitized profile, with verified hashes', async () => {
  const { root, source } = await cacheFixture()
  await fs.writeFile(path.join(source, 'History'), 'private browsing fixture')
  await fs.writeFile(
    cachePaths(source).state,
    JSON.stringify({ account_info: ['private account fixture'] }),
  )
  const destination = path.join(root, 'export')
  const manifest = await exportGemmaCache(source, destination)
  expect(manifest.files).toHaveLength(2)
  expect(manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(
    true,
  )
  expect(await verifyCacheManifest(destination)).toEqual(manifest)
  expect(await fs.readdir(destination)).not.toContain('History')
  const state = JSON.parse(
    await fs.readFile(cachePaths(destination).state, 'utf8'),
  )
  expect(state).toMatchObject({
    browser: {
      enabled_labs_experiments: ['gemma4-for-built-in-ai@1', 'prompt-api@1'],
    },
  })
  expect(state).not.toHaveProperty('account_info')
  expect(
    state.optimization_guide.model_execution.last_usage_by_feature
      .prompt_api_gemma4,
  ).toMatch(/^\d+$/)
})

test('refuses an existing unmarked profile and a running Chrome profile', async () => {
  const { source } = await cacheFixture()
  await fs.writeFile(path.join(source, 'SingletonLock'), 'active')
  await expect(assertCacheProfile(source)).rejects.toThrow()
  await safeDelete(path.join(source, 'SingletonLock'))
  await safeDelete(cachePaths(source).marker)
  await expect(initializeCacheProfile(source)).rejects.toThrow()
})

test('retains only exported Gemma registrations and strips unrelated state', async () => {
  const { root, source } = await cacheFixture()
  const publicKey = 'a1'.repeat(32)
  const nanoKey = 'b2'.repeat(32)
  const unknownKey = 'c3'.repeat(32)
  const staleKey = 'd4'.repeat(32)
  const requestedVersion = '2026.8.7.929'
  for (const key of [publicKey, nanoKey, unknownKey]) {
    const model = path.join(
      source,
      'OptGuideManifestModel',
      key,
      requestedVersion,
    )
    await fs.mkdir(model, { recursive: true })
    await fs.writeFile(path.join(model, 'weights.bin'), 'model fixture')
  }
  const sourceState = {
    account_info: ['private fixture'],
    optimization_guide: {
      model_execution: {
        manifest_asset_ledger: {
          [publicKey]: {
            asset_id: 'gemma4_component',
            requested_version: requestedVersion,
            private_note: 'private fixture',
          },
          [nanoKey]: {
            asset_id: 'nano_v3_cpu_component',
            requested_version: requestedVersion,
          },
          [unknownKey]: {
            asset_id: 'unrecognized_component',
            requested_version: requestedVersion,
          },
          [staleKey]: {
            asset_id: 'gemma4_component',
            requested_version: requestedVersion,
          },
        },
      },
    },
  }
  await fs.writeFile(cachePaths(source).state, JSON.stringify(sourceState))
  const destination = path.join(root, 'export')
  const manifest = await exportGemmaCache(source, destination)
  const state = JSON.parse(
    await fs.readFile(cachePaths(destination).state, 'utf8'),
  )
  expect(
    state.optimization_guide.model_execution.manifest_asset_ledger,
  ).toEqual({
    [publicKey]: {
      asset_id: 'gemma4_component',
      requested_version: requestedVersion,
    },
  })
  expect(state).not.toHaveProperty('account_info')
  expect(await verifyCacheManifest(destination)).toEqual(manifest)
  expect(
    JSON.parse(await fs.readFile(cachePaths(source).state, 'utf8')),
  ).toEqual(sourceState)
  const repeated = path.join(root, 'repeated')
  await exportGemmaCache(destination, repeated)
  const repeatedState = JSON.parse(
    await fs.readFile(cachePaths(repeated).state, 'utf8'),
  )
  expect(
    repeatedState.optimization_guide.model_execution.manifest_asset_ledger,
  ).toEqual(state.optimization_guide.model_execution.manifest_asset_ledger)
})

test('rejects registrations without exported assets during archive verification', async () => {
  const { root, source } = await cacheFixture()
  const destination = path.join(root, 'export')
  await exportGemmaCache(source, destination)
  const state = JSON.parse(
    await fs.readFile(cachePaths(destination).state, 'utf8'),
  )
  state.optimization_guide.model_execution.manifest_asset_ledger = {
    ['a1'.repeat(32)]: {
      asset_id: 'gemma4_component',
      requested_version: '2026.8.7.929',
    },
  }
  await fs.writeFile(cachePaths(destination).state, JSON.stringify(state))
  await expect(verifyCacheManifest(destination)).rejects.toThrow()
})

test('rejects a linked source state before creating an export', async () => {
  const { root, source } = await cacheFixture()
  const externalState = path.join(root, 'external-state.json')
  await fs.writeFile(externalState, '{}')
  await safeDelete(cachePaths(source).state)
  await fs.symlink(externalState, cachePaths(source).state)
  const destination = path.join(root, 'export')
  await expect(exportGemmaCache(source, destination)).rejects.toThrow()
  expect(existsSync(destination)).toBe(false)
})

test('exports portable model assets without copying or removing runtime caches', async () => {
  const { root, source } = await cacheFixture()
  const modelDirectory = 'OptGuideManifestModel/model/version'
  const runtimeFiles = [
    'cache.bin',
    'program_cache.bin',
    'program_cache.bin.dawn_version',
    'encoder_cache.bin',
    'adapter_cache.bin',
  ]
  const assets = [
    `${modelDirectory}/manifest.json`,
    `${modelDirectory}/on_device_model_execution_config.pb`,
    `${modelDirectory}/_metadata/verified_contents`,
    'OptGuideOnDeviceClassifierModel/version/classifier.bin',
  ]
  for (let i = 0, { length } = assets; i < length; i += 1) {
    const file = assets[i]!
    const target = path.join(source, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'portable model fixture')
  }
  for (let i = 0, { length } = runtimeFiles; i < length; i += 1) {
    const file = runtimeFiles[i]!
    await fs.writeFile(
      path.join(source, modelDirectory, file),
      'runtime cache fixture',
    )
  }
  const destination = path.join(root, 'export')
  const manifest = await exportGemmaCache(source, destination)
  expect(manifest.files.map(file => file.path)).toEqual(
    expect.arrayContaining(assets),
  )
  expect(manifest.files).toHaveLength(assets.length + 2)
  expect(
    (await fs.readdir(path.join(destination, modelDirectory))).toSorted(),
  ).toEqual([
    '_metadata',
    'manifest.json',
    'on_device_model_execution_config.pb',
    'weights.bin',
  ])
  for (let i = 0, { length } = runtimeFiles; i < length; i += 1) {
    const file = runtimeFiles[i]!
    expect(
      await fs.readFile(path.join(source, modelDirectory, file), 'utf8'),
    ).toBe('runtime cache fixture')
  }
  expect(await verifyCacheManifest(destination)).toEqual(manifest)
})

test('rejects incomplete model data and symlink entries', async () => {
  const { source } = await cacheFixture()
  const weights = path.join(
    source,
    'OptGuideManifestModel/model/version/weights.bin',
  )
  await safeDelete(weights)
  await expect(inventoryCache(source)).rejects.toThrow()
  await fs.symlink(cachePaths(source).state, weights)
  await expect(inventoryCache(source)).rejects.toThrow()
})

test('detects modified or added model files after export', async () => {
  const { root, source } = await cacheFixture()
  const destination = path.join(root, 'export')
  await exportGemmaCache(source, destination)
  await fs.writeFile(
    path.join(destination, 'OptGuideManifestModel/unexpected.bin'),
    'tampered',
  )
  await expect(verifyCacheManifest(destination)).rejects.toThrow()
  await expect(exportGemmaCache(source, destination)).rejects.toThrow()
})

test('reuses its own idle profile without replacing its state', async () => {
  const { source } = await cacheFixture()
  await fs.writeFile(cachePaths(source).state, '{"fixture":true}')
  await initializeCacheProfile(source)
  expect(await fs.readFile(cachePaths(source).state, 'utf8')).toBe(
    '{"fixture":true}',
  )
})

test('rejects arbitrary settings and executable bridge content in an export', async () => {
  const { root, source } = await cacheFixture()
  const destination = path.join(root, 'export')
  await exportGemmaCache(source, destination)
  const paths = cachePaths(destination)
  const cleanState = await fs.readFile(paths.state, 'utf8')
  const state = JSON.parse(cleanState)
  state.account_info = ['private fixture']
  await fs.writeFile(paths.state, JSON.stringify(state))
  await expect(verifyCacheManifest(destination)).rejects.toThrow()
  await fs.writeFile(paths.state, cleanState)
  await fs.writeFile(paths.bridge, '<script>throw Error("fixture")</script>')
  await expect(verifyCacheManifest(destination)).rejects.toThrow()
})
