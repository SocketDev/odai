/**
 * @file Simulator backend. Wraps the canned-response `LanguageModelSimulator`
 *   as a registry backend, so tests and bench drive the full backend interface
 *   without a global install and without Chrome.
 */

import { LanguageModelSimulator } from '../simulator.mts'
import type { LanguageModelSimulatorOptions } from '../simulator.mts'
import type { LanguageModelLike } from '../types.mts'
import type { BackendAvailability, OdaiBackend } from './types.mts'

export function createSimulatorBackend(
  options?: LanguageModelSimulatorOptions | undefined,
): OdaiBackend {
  const simulator = new LanguageModelSimulator(options)
  return {
    async availability(): Promise<BackendAvailability> {
      return { available: true }
    },
    async languageModel(): Promise<LanguageModelLike> {
      return simulator
    },
    name: 'simulator',
  }
}
