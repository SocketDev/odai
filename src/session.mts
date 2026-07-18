/**
 * @file Create a warm Prompt API session with the gotcha-handling fallback
 *   ladder. Two namespaces are probed, options are stripped on TypeError, and
 *   the returned base session is meant to be cloned per request.
 */

import type {
  LanguageModelLike,
  LanguageModelState,
  Message,
  SessionLike,
} from './types.mts'

export interface CreateOptions {
  initialPrompts?: Message[] | undefined
  systemPrompt?: string | undefined
  temperature?: number | undefined
  topK?: number | undefined
}

export function buildCreateOptions(
  options: CreateSessionOptions,
): CreateOptions {
  const opts = { __proto__: null, ...options } as typeof options
  const result: CreateOptions = {}
  if (opts.initialPrompts !== undefined && opts.initialPrompts.length > 0) {
    result.initialPrompts = opts.initialPrompts
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
  const modern = getModernLanguageModel()
  if (modern !== undefined) {
    const session = await createWithFallback(modern, options)
    return {
      cloneCapable: typeof session.clone === 'function',
      namespace: 'modern',
      session,
    }
  }

  const legacy = getLegacyLanguageModel()
  if (legacy !== undefined) {
    const session = await createWithFallback(legacy, options)
    return {
      cloneCapable: false,
      namespace: 'legacy',
      session,
    }
  }

  throw new Error('Chrome AI not found')
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
    initialPrompts: opts.initialPrompts,
  }
  try {
    return await model.create(reduced)
  } catch (error) {
    if (!isUnsupportedError(error)) {
      throw error
    }
  }

  const legacy: CreateSessionOptions = {
    systemPrompt: opts.systemPrompt,
  }
  return await model.create(legacy)
}

export function getLegacyLanguageModel(): LanguageModelLike | undefined {
  const globalWindow = globalThis as {
    ai?: { languageModel?: LanguageModelLike | undefined } | undefined
  }
  if (
    globalWindow.ai !== undefined &&
    globalWindow.ai.languageModel !== undefined
  ) {
    return globalWindow.ai.languageModel
  }
  return undefined
}

export interface CreateSessionOptions {
  initialPrompts?: Message[] | undefined
  systemPrompt?: string | undefined
  temperature?: number | undefined
  topK?: number | undefined
}

export function getModernLanguageModel(): LanguageModelLike | undefined {
  if (typeof LanguageModel !== 'undefined') {
    return LanguageModel as LanguageModelLike
  }
  return undefined
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
