/**
 * @file Probe the current runtime for a usable Prompt API implementation. The
 *   browser ships two namespaces depending on the Chrome build; Node ships
 *   neither. This module returns a normalized availability answer without
 *   creating an expensive session.
 */

import type { LanguageModelLike } from './types.mts'

export function getLegacyLanguageModel(): LanguageModelLike | undefined {
  const globalWindow = globalThis as {
    ai?: { languageModel?: LanguageModelLike | undefined } | undefined
    window?:
      | {
          ai?: { languageModel?: LanguageModelLike | undefined } | undefined
        }
      | undefined
  }
  if (
    globalWindow.ai !== undefined &&
    globalWindow.ai.languageModel !== undefined
  ) {
    return globalWindow.ai.languageModel
  }
  if (
    globalWindow.window !== undefined &&
    globalWindow.window.ai !== undefined &&
    globalWindow.window.ai.languageModel !== undefined
  ) {
    return globalWindow.window.ai.languageModel
  }
  return undefined
}

export interface AvailabilityResult {
  available: boolean
  cloneCapable: boolean
  namespace: 'modern' | 'legacy' | 'none'
}

export function getModernLanguageModel(): LanguageModelLike | undefined {
  if (typeof LanguageModel !== 'undefined') {
    return LanguageModel as LanguageModelLike
  }
  return undefined
}

export function isAvailableState(state: string | undefined): boolean {
  return state === 'available' || state === 'readily'
}

export async function probeAvailability(): Promise<AvailabilityResult> {
  const modern = getModernLanguageModel()
  if (modern !== undefined) {
    const state = await readAvailability(modern)
    return {
      available: isAvailableState(state),
      cloneCapable: true,
      namespace: 'modern',
    }
  }
  const legacy = getLegacyLanguageModel()
  if (legacy !== undefined) {
    const state = await readAvailability(legacy)
    return {
      available: isAvailableState(state),
      cloneCapable: false,
      namespace: 'legacy',
    }
  }
  return {
    available: false,
    cloneCapable: false,
    namespace: 'none',
  }
}

export async function readAvailability(
  model: LanguageModelLike,
): Promise<string | undefined> {
  if (typeof model.availability === 'function') {
    const result = await model.availability()
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
  }
  if (typeof model.capabilities === 'function') {
    const result = await model.capabilities()
    if (
      result !== undefined &&
      result !== null &&
      typeof result === 'object' &&
      'available' in result
    ) {
      return String(result.available)
    }
  }
  return undefined
}
