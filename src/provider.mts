/**
 * @file Expose a local model factory with an opaque session contract. Backend
 *   selection is shared across availability checks and session creation.
 */

import { isLanguageModelFactory as isBuiltinLanguageModelFactory } from '@socketsecurity/lib/ai/builtin'

import { selectBackend } from './backends/registry.mts'
import type { SelectBackendOptions } from './backends/registry.mts'
import type { OdaiBackend } from './backends/types.mts'
export type LanguageModelAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'

export interface LanguageModelFactory {
  availability(
    options?: unknown | undefined,
  ): Promise<LanguageModelAvailability>
  create(options?: unknown | undefined): Promise<unknown>
}

/**
 * Build a socket-lib `LanguageModelFactory` backed by an odai backend. The
 * backend is selected lazily and once — `availability()` and `create()` share
 * the same selection so a router probe followed by a session create does not
 * re-run the probe ladder. Selection follows the usual precedence: an explicit
 * `backend`, then `ODAI_BACKEND`, then the availability probe order.
 */
export function createLocalLanguageModelFactory(
  options?: SelectBackendOptions | undefined,
): LanguageModelFactory {
  const opts = { __proto__: null, ...options } as SelectBackendOptions
  let backendPromise: Promise<OdaiBackend> | undefined
  const resolveBackend = (): Promise<OdaiBackend> => {
    backendPromise ??= selectBackend(opts)
    return backendPromise
  }
  return {
    async availability(): Promise<LanguageModelAvailability> {
      try {
        // `selectBackend` only resolves with an available backend; it throws
        // when none is usable, so a resolved promise is proof of availability.
        await resolveBackend()
        return 'available'
      } catch {
        // Drop the memoized rejection so a later call can re-probe, e.g. after
        // an engine is brought up.
        backendPromise = undefined
        return 'unavailable'
      }
    },
    async create(createOptions?: unknown | undefined): Promise<unknown> {
      const backend = await resolveBackend()
      const model = await backend.languageModel()
      return model.create(createOptions as object | undefined)
    },
  }
}

export function isLanguageModelFactory(
  value: unknown,
): value is LanguageModelFactory {
  return isBuiltinLanguageModelFactory(value)
}
