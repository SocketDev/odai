import { createChromeBuiltinBackend } from '../chrome-builtin.mts'
import { resolveBridgeConfig } from '../chrome-profile.mts'
import { detectModelName } from '../../model-identity.mts'
import type {
  ChromeBuiltinBackend,
  ChromeBuiltinOptions,
} from '../chrome-builtin.mts'
import type { ModelIdentity } from '../../model-identity.mts'
import type { ResolvedBridgeConfig } from '../chrome-profile.mts'

export interface ChromeSetupOptions extends Omit<
  ChromeBuiltinOptions,
  'allowDownload'
> {}

export interface ChromeSetupReceipt {
  backend: 'chrome-builtin'
  chromePath: string
  identity: ModelIdentity
  model: string
  profile: string
}

export interface ChromeSetupDependencies {
  createBackend(options: ChromeBuiltinOptions): ChromeBuiltinBackend
  resolveConfig(options: ChromeBuiltinOptions): Promise<ResolvedBridgeConfig>
}

export async function setupChromeBuiltin(
  options: ChromeSetupOptions = {},
  dependencies?: Partial<ChromeSetupDependencies> | undefined,
): Promise<ChromeSetupReceipt> {
  const opts = { __proto__: null, ...options } as ChromeSetupOptions
  const resolveConfig = dependencies?.resolveConfig ?? resolveBridgeConfig
  const config = await resolveConfig({ ...opts, allowDownload: true })
  if (config.chromePath === undefined) {
    throw new Error(
      'Chrome setup could not find Google Chrome. Where: executable discovery. Saw no supported browser; wanted a real Google Chrome installation. Fix: install Google Chrome or pass chromePath.',
    )
  }
  const createBackend =
    dependencies?.createBackend ?? createChromeBuiltinBackend
  const backend = createBackend({ ...opts, allowDownload: true })
  try {
    const availability = await backend.availability()
    if (!availability.available) {
      throw new Error(
        `Chrome setup is unavailable. Where: backend preflight. Saw ${availability.reason ?? 'no reason'}; wanted a downloadable or installed on-device model. Fix: address the reported Chrome requirement and retry.`,
      )
    }
    const factory = await backend.languageModel()
    const session = await factory.create({ temperature: 0, topK: 1 })
    try {
      const identity = await detectModelName(session)
      const expected = config.model === 'gemma4' ? 'Gemma 4' : 'Gemini'
      const matches =
        config.model === 'gemma4'
          ? identity.name === expected
          : identity.name === 'Gemini' || identity.name === 'Gemini Nano'
      if (!matches) {
        throw new Error(
          `Chrome setup verified the wrong model. Where: identity prompt. Saw ${identity.name ?? 'an unknown model'}; wanted ${expected}. Fix: remove the Odai Chrome profile and run setup again with the intended model.`,
        )
      }
      return {
        backend: 'chrome-builtin',
        chromePath: config.chromePath,
        identity,
        model: config.model,
        profile: config.userDataDir,
      }
    } finally {
      session.destroy?.()
    }
  } finally {
    await backend.close()
  }
}
