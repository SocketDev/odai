/**
 * @file Resolve the built-in on-device LanguageModel factory and probe its
 *   availability. Resolution is delegated to `@socketsecurity/lib/ai/builtin`,
 *   which discovers the browser `globalThis.LanguageModel`, the smol Node
 *   `node:smol-ai` Prompt API, and the optional `@node-smol/ai` native addon —
 *   a strict superset of the browser-only global this module used to fork. The
 *   resolved factory is adapted to odai's richer `LanguageModelLike` session
 *   interface. This module returns a normalized availability answer without
 *   creating an expensive session.
 */

import { getLanguageModel as getBuiltinLanguageModel } from '@socketsecurity/lib/ai/builtin'

import type { LanguageModelLike, SessionLike } from './types.mts'
import type { LanguageModelFactory } from '@socketsecurity/lib/ai/builtin'

export interface AvailabilityResult {
  available: boolean
  cloneCapable: boolean
  namespace: 'modern' | 'none'
}

/**
 * Bridge the socket-lib `LanguageModelFactory` to odai's `LanguageModelLike`.
 * The factory's opaque `create()` result is the concrete Prompt API session at
 * runtime; odai's session interface types it as `SessionLike` so the fallback
 * ladder and task helpers stay strongly typed.
 */
export function adaptLanguageModelFactory(
  factory: LanguageModelFactory,
): LanguageModelLike {
  return {
    availability: () => factory.availability(),
    create: (options?: object | undefined) =>
      factory.create(options) as Promise<SessionLike>,
  }
}

export function getLanguageModel(): LanguageModelLike | undefined {
  const factory = getBuiltinLanguageModel()
  if (factory === undefined) {
    return undefined
  }
  return adaptLanguageModelFactory(factory)
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
  // Widen to unknown: the session type promises a string, but this probe also
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
