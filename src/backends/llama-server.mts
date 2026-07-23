/**
 * @file Llama-server backend declaration. Reserves the registry slot for the
 *   OpenAI-compatible session adapter — llama.cpp's `llama-server`, ollama,
 *   and anything speaking the same endpoint — which ships in the next phase.
 *   Until the adapter lands, availability reports unavailable with this
 *   reason so probe order falls through cleanly.
 */

import type { LanguageModelLike } from '../types.mts'
import type { BackendAvailability, LocaiBackend } from './types.mts'

export const LLAMA_SERVER_UNAVAILABLE_REASON =
  'llama-server is declared for selection and bench wiring; its ' +
  'OpenAI-compatible session adapter ships in the next phase. Select the ' +
  'simulator backend, or run inside Chrome for gemini-nano-headless.'

export function createLlamaServerBackend(): LocaiBackend {
  return {
    async availability(): Promise<BackendAvailability> {
      return { available: false, reason: LLAMA_SERVER_UNAVAILABLE_REASON }
    },
    async languageModel(): Promise<LanguageModelLike> {
      throw new Error(LLAMA_SERVER_UNAVAILABLE_REASON)
    },
    name: 'llama-server',
  }
}
