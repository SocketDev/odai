/**
 * @file Backend interface types. A backend wraps one on-device inference engine
 *   behind the `LanguageModel` factory shape, so the session fallback ladder
 *   and JSON hardening drive every engine the same way.
 */

import type { LanguageModelLike } from '../types.mts'

/**
 * Names of the declared backends, in alphabetical order. Selection probes them
 * in `defaultProbeOrder` from the registry.
 */
export type BackendName =
  | 'apple-fm'
  | 'chrome-builtin'
  | 'llama-server'
  | 'simulator'
  | 'windows-phi-silica'

export interface BackendAvailability {
  available: boolean
  /**
   * Why the backend is unavailable, phrased for a human deciding what to do
   * next. Present whenever `available` is false.
   */
  reason?: string | undefined
}

export interface OdaiBackend {
  availability(): Promise<BackendAvailability>
  /**
   * The engine's session factory. `createOdaiModel` runs the session-option
   * fallback ladder against it, so a backend only supplies the factory and
   * never re-implements option handling.
   */
  languageModel(): Promise<LanguageModelLike>
  readonly name: BackendName
}
