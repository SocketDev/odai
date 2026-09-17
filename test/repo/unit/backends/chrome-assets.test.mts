import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { afterEach, expect, it } from 'vitest'

import { hasChromeModelAssets } from '../../../../src/backends/chrome-assets.mts'
import {
  buildLocalStateSeed,
  ensureBridgeProfile,
  findModelSource,
} from '../../../../src/backends/chrome-profile.mts'

const roots: string[] = []
const gemmaKey = 'a'.repeat(64)

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await safeDelete(root)
  }
})

async function createProfile(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'odai-assets-'))
  roots.push(root)
  return root
}

async function writeGemmaProfile(
  profile: string,
  assetId = 'gemma4_component',
  weights = 'model weights',
): Promise<void> {
  const version = '2026.9.1.1'
  const directory = path.join(
    profile,
    'OptGuideManifestModel',
    gemmaKey,
    version,
  )
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'weights.bin'), weights)
  await writeFile(
    path.join(profile, 'Local State'),
    JSON.stringify({
      optimization_guide: {
        model_execution: {
          manifest_asset_ledger: {
            [gemmaKey]: { asset_id: assetId, requested_version: version },
          },
        },
      },
    }),
  )
}

it('rejects empty component directories before browser startup', async () => {
  const root = await createProfile()
  await mkdir(path.join(root, 'OptGuideOnDeviceModel'))
  await mkdir(path.join(root, 'OptGuideManifestModel'))
  const source = await findModelSource({
    allowDownload: false,
    chromePath: undefined,
    chromePathCandidates: [],
    model: 'gemma4',
    systemChromeUserDataDir: root,
    userDataDir: root,
  })
  expect(source.kind).toBe('download')
  expect(source.reason).toBeDefined()
  await mkdir(path.join(root, 'OptGuideOnDeviceModel', '2026.9.1.1'))
  expect(await hasChromeModelAssets(root, 'geminiNano')).toBe(false)
})

it('does not use Gemini Nano weights as evidence that Gemma is cached', async () => {
  const root = await createProfile()
  const directory = path.join(root, 'OptGuideOnDeviceModel', '2025.8.8.1141')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'weights.bin'), 'nano weights')
  expect(await hasChromeModelAssets(root, 'geminiNano')).toBe(true)
  expect(await hasChromeModelAssets(root, 'gemma4')).toBe(false)
})

it('requires nonempty weights registered to the selected Gemma component', async () => {
  const root = await createProfile()
  await writeGemmaProfile(root, 'other_component')
  expect(await hasChromeModelAssets(root, 'gemma4')).toBe(false)
  await writeGemmaProfile(root, 'gemma4_component', '')
  expect(await hasChromeModelAssets(root, 'gemma4')).toBe(false)
  await writeGemmaProfile(root)
  expect(await hasChromeModelAssets(root, 'gemma4')).toBe(true)
})

it('preserves model registrations and seeds the Gemma feature key', () => {
  const ledger = {
    [gemmaKey]: {
      asset_id: 'gemma4_component',
      requested_version: '2026.9.1.1',
    },
  }
  const result = buildLocalStateSeed(
    {
      optimization_guide: {
        model_execution: {
          manifest_asset_ledger: ledger,
          last_usage_by_feature: { existing_feature: '123' },
        },
      },
    },
    { onDevice: {}, updaterApp: undefined },
    { model: 'gemma4' },
  ) as {
    optimization_guide: {
      model_execution: {
        manifest_asset_ledger: unknown
        last_usage_by_feature: Record<string, string>
      }
    }
  }
  expect(
    result.optimization_guide.model_execution.manifest_asset_ledger,
  ).toEqual(ledger)
  expect(
    result.optimization_guide.model_execution.last_usage_by_feature[
      'existing_feature'
    ],
  ).toBe('123')
  expect(
    result.optimization_guide.model_execution.last_usage_by_feature[
      'prompt_api_gemma4'
    ],
  ).toBeDefined()
})

it('repairs an empty target from the populated source and retains its registration', async () => {
  const source = await createProfile()
  const target = await createProfile()
  await writeGemmaProfile(source)
  await mkdir(path.join(target, 'OptGuideManifestModel', gemmaKey), {
    recursive: true,
  })
  await ensureBridgeProfile(
    {
      allowDownload: false,
      chromePath: undefined,
      chromePathCandidates: [],
      model: 'gemma4',
      systemChromeUserDataDir: source,
      userDataDir: target,
    },
    { kind: 'system' },
  )
  expect(await hasChromeModelAssets(target, 'gemma4')).toBe(true)
  await ensureBridgeProfile(
    {
      allowDownload: false,
      chromePath: undefined,
      chromePathCandidates: [],
      model: 'gemma4',
      systemChromeUserDataDir: source,
      userDataDir: target,
    },
    { kind: 'profile' },
  )
  expect(await hasChromeModelAssets(target, 'gemma4')).toBe(true)
  expect(
    JSON.parse(await readFile(path.join(target, 'Local State'), 'utf8')).browser
      .enabled_labs_experiments,
  ).toContain('prompt-api@1')
})
