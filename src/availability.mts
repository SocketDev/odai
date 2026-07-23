/**
 * @file Probe the current runtime for a usable Prompt API implementation. The
 *   browser ships two namespaces depending on the Chrome build; Node ships
 *   neither. This module returns a normalized availability answer without
 *   creating an expensive session.
 */

import type { LanguageModelLike } from './types.mts'

export interface AvailabilityResult {
  available: boolean
  cloneCapable: boolean
  namespace: 'modern' | 'none'
}

export function getLanguageModel(): LanguageModelLike | undefined {
  if (typeof LanguageModel !== 'undefined') {
    return LanguageModel as LanguageModelLike
  }
  return undefined
}

export function isAvailableState(state: string | undefined): boolean {
  return state === 'available' || state === 'readily'
}

export async function probeAvailability(): Promise<AvailabilityResult> {
  const model = getLanguageModel()
  if (model === undefined) {
    return {
      available: false,
      cloneCapable: false,
      namespace: 'none',
    }
  }
  const state = await readAvailability(model)
  return {
    available: isAvailableState(state),
    cloneCapable: true,
    namespace: 'modern',
  }
}

export async function readAvailability(
  model: LanguageModelLike,
): Promise<string | undefined> {
  if (typeof model.availability !== 'function') {
    return undefined
  }
  // Widen to unknown: the seam type promises a string, but this probe also
  // guards runtimes that hand back exotic availability objects.
  const result: unknown = await model.availability()
  if (typeof result === 'string') {
    return result
  }
  if (
    result !== undefined &&
    result !== null &&
    typeof result === 'object' &&
    'availability' in result
  ) {
    return String(result.availability)
  }
  return undefined
}
