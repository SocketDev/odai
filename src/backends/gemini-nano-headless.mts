/**
 * @file Gemini Nano backend. Uses the runtime's `LanguageModel` global — real
 *   inside Chrome with the Prompt API enabled. The headless Chrome bridge that
 *   provisions that global from Node ships in the next phase; today this
 *   backend is available exactly where the global already is.
 */

import { getLanguageModel, probeAvailability } from '../availability.mts'
import type { LanguageModelLike } from '../types.mts'
import type { BackendAvailability, LocaiBackend } from './types.mts'

export const GEMINI_NANO_UNAVAILABLE_REASON =
  'gemini-nano-headless needs a LanguageModel global that reports available; ' +
  'this runtime has none. Run inside Chrome with the Prompt API enabled, or ' +
  'select another backend.'

export function createGeminiNanoHeadlessBackend(): LocaiBackend {
  return {
    async availability(): Promise<BackendAvailability> {
      const probe = await probeAvailability()
      if (probe.available) {
        return { available: true }
      }
      return { available: false, reason: GEMINI_NANO_UNAVAILABLE_REASON }
    },
    async languageModel(): Promise<LanguageModelLike> {
      const model = getLanguageModel()
      if (model === undefined) {
        throw new Error(GEMINI_NANO_UNAVAILABLE_REASON)
      }
      return model
    },
    name: 'gemini-nano-headless',
  }
}
