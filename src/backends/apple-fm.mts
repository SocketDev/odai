/**
 * @file Apple Foundation Models backend declaration. Deferred indefinitely:
 *   Apple Intelligence reports deviceNotEligible inside VMs, every
 *   GitHub-hosted macOS runner is a VM, and Apple warns its ~3B on-device
 *   model off code generation with a 4K combined context. The slot exists so
 *   selection, docs, and bench name the option and its status honestly.
 */

import type { LanguageModelLike } from '../types.mts'
import type { BackendAvailability, LocaiBackend } from './types.mts'

export const APPLE_FM_UNAVAILABLE_REASON =
  'apple-fm is declared but deferred: Apple Intelligence reports ' +
  'deviceNotEligible inside VMs (all GitHub-hosted macOS runners are VMs), ' +
  'and Apple warns its ~3B on-device model off code generation. Revisit if a ' +
  'bare-metal Apple silicon fleet materializes.'

export function createAppleFmBackend(): LocaiBackend {
  return {
    async availability(): Promise<BackendAvailability> {
      return { available: false, reason: APPLE_FM_UNAVAILABLE_REASON }
    },
    async languageModel(): Promise<LanguageModelLike> {
      throw new Error(APPLE_FM_UNAVAILABLE_REASON)
    },
    name: 'apple-fm',
  }
}
