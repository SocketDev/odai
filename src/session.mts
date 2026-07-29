/**
 * @file Create a warm Prompt API session with the gotcha-handling fallback
 *   ladder. Only the stable `LanguageModel` global is used; options are
 *   stripped on TypeError, and the returned base session is meant to be cloned
 *   per request.
 */

import { getLanguageModel } from './availability.mts'
import { parseControlTokens } from './control-tokens.mts'
import type {
  LanguageModelLike,
  LanguageModelState,
  Message,
  SessionLike,
} from './types.mts'

export function buildCreateOptions(
  options: CreateSessionOptions,
): CreateOptions {
  const opts = { __proto__: null, ...options } as typeof options
  const result: CreateOptions = {}
  const initialPrompts = resolveInitialPrompts(options)
  if (initialPrompts !== undefined) {
    result.initialPrompts = initialPrompts
  } else if (opts.systemPrompt !== undefined) {
    result.systemPrompt = opts.systemPrompt
  }
  if (opts.temperature !== undefined) {
    result.temperature = opts.temperature
  }
  if (opts.topK !== undefined) {
    result.topK = opts.topK
  }
  return result
}

export async function createLanguageModel(
  options: CreateSessionOptions = {},
): Promise<LanguageModelState> {
  const model = getLanguageModel()
  if (model === undefined) {
    throw new Error('Chrome AI not found')
  }
  const session = await createWithFallback(model, options)
  return {
    cloneCapable: typeof session.clone === 'function',
    namespace: 'modern',
    session,
  }
}

export async function createWithFallback(
  model: LanguageModelLike,
  options: CreateSessionOptions,
): Promise<SessionLike> {
  const opts = { __proto__: null, ...options } as typeof options
  const full = buildCreateOptions(options)
  try {
    return await model.create(full)
  } catch (error) {
    if (!isUnsupportedError(error)) {
      throw error
    }
  }

  const reduced: CreateSessionOptions = {
    initialPrompts: resolveInitialPrompts(options),
  }
  try {
    return await model.create(reduced)
  } catch (error) {
    if (!isUnsupportedError(error)) {
      throw error
    }
  }

  const systemOnly: CreateSessionOptions = {
    systemPrompt: opts.systemPrompt,
  }
  return await model.create(systemOnly)
}

export interface CreateSessionOptions {
  /**
   * A Chrome control-token template (`$SYSTEM` / `$USER` / `$MODEL` / `$END`).
   * Parsed into `initialPrompts` when `initialPrompts` is not given explicitly.
   */
  controlTemplate?: string | undefined
  initialPrompts?: Message[] | undefined
  systemPrompt?: string | undefined
  temperature?: number | undefined
  topK?: number | undefined
}

export function isUnsupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const name = error.name
  return (
    name === 'TypeError' ||
    name === 'NotSupportedError' ||
    error.message.toLowerCase().includes('not supported')
  )
}

export interface CreateOptions {
  initialPrompts?: Message[] | undefined
  systemPrompt?: string | undefined
  temperature?: number | undefined
  topK?: number | undefined
}

export function resolveInitialPrompts(
  options: CreateSessionOptions,
): Message[] | undefined {
  const opts = { __proto__: null, ...options } as typeof options
  if (opts.initialPrompts !== undefined && opts.initialPrompts.length > 0) {
    return opts.initialPrompts
  }
  if (opts.controlTemplate !== undefined) {
    const parsed = parseControlTokens(opts.controlTemplate)
    if (parsed.length > 0) {
      return parsed
    }
  }
  return undefined
}
