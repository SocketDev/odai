/**
 * @file Resolve local model factories through the bundled runtime helper.
 *   Availability checks do not create an expensive session.
 */

import { getLanguageModel as getBuiltinLanguageModel } from '@socketsecurity/lib/ai/builtin'

import type { LanguageModelLike, SessionLike } from './types.mts'
import type { LanguageModelFactory } from './provider.mts'

export interface BuiltinAvailability {
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

export async function probeBuiltinAvailability(): Promise<BuiltinAvailability> {
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
