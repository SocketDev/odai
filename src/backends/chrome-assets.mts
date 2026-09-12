import type { ChromeModelKey } from './chrome-models.mts'

export async function hasChromeModelAssets(
  profile: string,
  model: ChromeModelKey,
): Promise<boolean> {
  return model === 'gemma4' ? hasGemmaAssets(profile) : hasNanoAssets(profile)
}

export async function hasGemmaAssets(profile: string): Promise<boolean> {
  const path = await import('node:path')
  const state = await readChromeAssetState(profile)
  const guide = state['optimization_guide']
  const execution = isChromeAssetRecord(guide)
    ? guide['model_execution']
    : undefined
  const ledger = isChromeAssetRecord(execution)
    ? execution['manifest_asset_ledger']
    : undefined
  if (!isChromeAssetRecord(ledger)) {
    return false
  }
  const entries = Object.entries(ledger)
  for (let i = 0, { length } = entries; i < length; i += 1) {
    const { 0: key, 1: asset } = entries[i]!
    if (!isGemmaAssetReference(key, asset)) {
      continue
    }
    if (
      await hasModelWeightFile(
        path.join(
          profile,
          'OptGuideManifestModel',
          key,
          asset.requested_version,
          'weights.bin',
        ),
      )
    ) {
      return true
    }
  }
  return false
}

export async function hasModelWeightFile(filename: string): Promise<boolean> {
  const fs = await import('node:fs/promises')
  try {
    // oxlint-disable-next-line socket/prefer-exists-sync -- File type and size.
    const info = await fs.stat(filename)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

export async function hasNanoAssets(profile: string): Promise<boolean> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const root = path.join(profile, 'OptGuideOnDeviceModel')
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    for (let i = 0, { length } = entries; i < length; i += 1) {
      const entry = entries[i]!
      if (
        entry.isDirectory() &&
        /^\d+(?:\.\d+){3}$/.test(entry.name) &&
        (await hasModelWeightFile(path.join(root, entry.name, 'weights.bin')))
      ) {
        return true
      }
    }
  } catch {
    return false
  }
  return false
}

export function isChromeAssetRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isGemmaAssetReference(
  key: string,
  value: unknown,
): value is { requested_version: string } {
  return (
    /^[a-f0-9]{64}$/.test(key) &&
    isChromeAssetRecord(value) &&
    value['asset_id'] === 'gemma4_component' &&
    typeof value['requested_version'] === 'string' &&
    /^\d+(?:\.\d+){3}$/.test(value['requested_version'])
  )
}

export async function readChromeAssetState(
  profile: string,
): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(path.join(profile, 'Local State'), 'utf8'),
    )
    return isChromeAssetRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
