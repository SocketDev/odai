/**
 * @file Which on-device model the Chrome backend asks for, and whether a given
 *   Chrome can serve it. Pure data and pure functions: no node: imports, no
 *   filesystem, so the table stays readable from the browser bundle and from a
 *   check script. Provisioning the profile that carries the model lives in
 *   `chrome-profile.mts`.
 */

import { MODELS } from '../models.mts'
import type { ModelName } from '../models.mts'

export const ODAI_CHROME_ENV_VAR = 'ODAI_CHROME'
export const ODAI_CHROME_ALLOW_DOWNLOAD_ENV_VAR = 'ODAI_CHROME_ALLOW_DOWNLOAD'
export const ODAI_CHROME_MODEL_ENV_VAR = 'ODAI_CHROME_MODEL'
export const ODAI_CHROME_USER_DATA_DIR_ENV_VAR = 'ODAI_CHROME_USER_DATA_DIR'

/**
 * Selector token for a Chrome-loadable model, e.g. `gemma4`.
 */
export type ChromeModelKey = 'geminiNano' | 'gemma4'

export interface ChromeModelSpec {
  /**
   * The name `detectModelName` reports once this model is loaded, measured by
   * asking the live model. A check script cross-references it against the
   * identity matcher table so a selectable model is always identifiable.
   */
  identity: ModelName
  /**
   * The `chrome://flags` selection that loads this model, absent for the
   * default. Chrome drops labs ids it does not recognize rather than
   * complaining, so an unsupported build prunes this and quietly serves the
   * default - which is what `minChromeMajor` exists to catch.
   */
  labsExperiment?: string | undefined
  /**
   * Oldest Chrome major version that carries the flag.
   */
  minChromeMajor?: number | undefined
}

/**
 * The models the Chrome backend can ask for, keyed by selector token. Gemma 4
 * arrives through one flag that covers every built-in AI API, the Prompt API
 * included, so selecting it swaps the weights behind the existing bridge
 * rather than adding a surface. Chrome Dev 154 is where it was measured; 153
 * is the milestone the flag shipped in, so the gate admits 153.
 */
export const CHROME_MODELS = {
  geminiNano: {
    identity: MODELS.geminiNano,
    labsExperiment: undefined,
    minChromeMajor: undefined,
  },
  gemma4: {
    identity: MODELS.gemma4,
    labsExperiment: 'gemma4-for-built-in-ai@1',
    minChromeMajor: 153,
  },
} as const satisfies Record<ChromeModelKey, ChromeModelSpec>

export const chromeModelKeys: readonly ChromeModelKey[] = Object.keys(
  CHROME_MODELS,
) as ChromeModelKey[]

/**
 * The model loaded when a caller names none.
 */
export const DEFAULT_CHROME_MODEL: ChromeModelKey = 'geminiNano'

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
 * The flag selections to seed for the named model.
 */
export function enabledLabsExperiments(
  options: { model?: ChromeModelKey | undefined } = {},
): string[] {
  const opts = { __proto__: null, ...options } as typeof options
  const spec = CHROME_MODELS[opts.model ?? DEFAULT_CHROME_MODEL]
  return spec.labsExperiment === undefined
    ? [...ENABLED_LABS_EXPERIMENTS]
    : [...ENABLED_LABS_EXPERIMENTS, spec.labsExperiment]
}

export function isChromeModelKey(value: string): value is ChromeModelKey {
  return Object.hasOwn(CHROME_MODELS, value)
}

/**
 * Why this Chrome cannot serve the named model, or undefined when it can.
 * Chrome drops labs ids it does not recognize instead of reporting them, so an
 * ungated selection on an older build would seed a flag that silently vanishes
 * and hand back the default model while the caller believes otherwise.
 */
export function modelUnsupportedReason(
  model: ChromeModelKey,
  chromeMajor: number | undefined,
  chromePath: string,
): string | undefined {
  const spec = CHROME_MODELS[model]
  const required = spec.minChromeMajor
  if (required === undefined) {
    return undefined
  }
  if (chromeMajor !== undefined && chromeMajor >= required) {
    return undefined
  }
  const found =
    chromeMajor === undefined
      ? 'its version could not be read'
      : `it reports major version ${chromeMajor}`
  return (
    `Model "${model}" (${spec.identity}) was requested via ` +
    `${ODAI_CHROME_MODEL_ENV_VAR} or the model option, but ${chromePath} ` +
    `cannot serve it: ${found}, and the ${spec.labsExperiment} flag needs ` +
    `Chrome ${required} or newer (dev or canary channel). Point ` +
    `${ODAI_CHROME_ENV_VAR} at a newer Chrome, or select ` +
    `"${DEFAULT_CHROME_MODEL}".`
  )
}

/**
 * Major version from Chrome's `--version` line, e.g. "Google Chrome
 * 154.0.8025.0 dev" yields 154. Undefined when no version is present.
 */
export function parseChromeMajorVersion(
  versionOutput: string,
): number | undefined {
  const match = /(\d+)\.\d+\.\d+\.\d+/.exec(versionOutput)
  return match === null ? undefined : Number(match[1])
}

/**
 * The model named by `ODAI_CHROME_MODEL`, or the default when unset. Throws on
 * an unrecognized token rather than falling back, so a typo surfaces instead
 * of silently running the wrong weights.
 */
export function readEnvChromeModel(
  env: Record<string, string | undefined>,
): ChromeModelKey {
  const value = env[ODAI_CHROME_MODEL_ENV_VAR]
  if (value === undefined || value === '') {
    return DEFAULT_CHROME_MODEL
  }
  if (!isChromeModelKey(value)) {
    throw new Error(
      `${ODAI_CHROME_MODEL_ENV_VAR} is "${value}"; expected one of ` +
        `${chromeModelKeys.join(', ')}. Unset it or name a declared model.`,
    )
  }
  return value
}
