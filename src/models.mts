/**
 * @file Canonical on-device model names. One table, two consumers: the
 *   identity probe matches a model's self-reported reply against these names,
 *   and the Chrome backend names the model it asks Chrome to load. Keys are the
 *   selector tokens a caller or env var uses; values are the canonical names
 *   stamped onto a `TaskResult`, so they are public surface and do not change
 *   casing or spacing on a whim. Families and versions both appear: a model
 *   that reports only "Gemma" still resolves, and "Gemma 4" wins over it.
 */

export const MODELS = {
  gemini: 'Gemini',
  geminiNano: 'Gemini Nano',
  gemma: 'Gemma',
  gemma4: 'Gemma 4',
} as const

/**
 * A selector token, e.g. `gemma4`.
 */
export type ModelKey = keyof typeof MODELS

/**
 * A canonical model name, e.g. `Gemma 4`.
 */
export type ModelName = (typeof MODELS)[ModelKey]

export const modelKeys: readonly ModelKey[] = Object.keys(MODELS) as ModelKey[]

export function isModelKey(value: string): value is ModelKey {
  return Object.hasOwn(MODELS, value)
}
