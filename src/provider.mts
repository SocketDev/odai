/**
 * @file Expose odai as a socket-lib-routable keyless local provider. socket-lib
 *   declares the built-in `LanguageModelFactory` interface in `ai/builtin` and
 *   drives local, keyless models through it. odai's backends already implement
 *   the richer `LanguageModelLike` session shape; this module selects a backend
 *   and adapts it to the socket-lib `LanguageModelFactory` contract, so
 *   socket-lib's router can invoke odai in-process — no key, no CLI, no hosted
 *   fallback. The dependency stays one-way: odai never imports socket-lib's
 *   router, only the `ai/builtin` factory shape it publishes.
 */

import { isLanguageModelFactory } from '@socketsecurity/lib/ai/builtin'

import { selectBackend } from './backends/registry.mts'
import type { SelectBackendOptions } from './backends/registry.mts'
import type { OdaiBackend } from './backends/types.mts'
import type {
  LanguageModelAvailability,
  LanguageModelFactory,
} from '@socketsecurity/lib/ai/builtin'

export { isLanguageModelFactory }
export type { LanguageModelAvailability, LanguageModelFactory }

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
