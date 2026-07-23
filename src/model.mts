/**
 * @file High-level model wrapper. Holds a warm base session, clones it per
 *   request, and destroys the clone afterwards. This avoids the state-growth
 *   gotcha where every prompt appends to the same conversation history.
 *   `createLocaiModel` builds the wrapper on any registry backend;
 *   `createGeminiNanoModel` is the compat entry bound to the runtime's
 *   `LanguageModel` global.
 */

import { selectBackend } from './backends/registry.mts'
import { promptStructured } from './json.mts'
import { createLanguageModel, createWithFallback } from './session.mts'
import { streamPrompt } from './stream.mts'
import type { BackendName, LocaiBackend } from './backends/types.mts'
import type { CreateSessionOptions } from './session.mts'
import type {
  LanguageModelState,
  Message,
  SessionLike,
  StructuredPromptOptions,
  TaskResult,
} from './types.mts'
import type { StreamOptions } from './stream.mts'

export type { CreateSessionOptions, LanguageModelState }

export interface LocaiModel {
  promptStructured<T>(
    userContent: string,
    options: StructuredPromptOptions<T>,
  ): Promise<TaskResult<T>>
  promptStreaming(
    userContent: string,
    options?: StreamOptions | undefined,
  ): Promise<{ raw: string }>
  rawSession(): SessionLike
}

/**
 * Compat alias from the Nano-only era; `LocaiModel` is the canonical name.
 */
export type GeminiNanoModel = LocaiModel

export interface CreateLocaiModelOptions extends CreateSessionOptions {
  /**
   * Explicit backend: a registry name or a caller-built `LocaiBackend`.
   * Selection precedence when omitted: `LOCAI_BACKEND` env var, then the
   * availability probe order.
   */
  backend?: BackendName | LocaiBackend | undefined
  /**
   * Availability probe order override for auto-selection.
   */
  probe?: readonly BackendName[] | undefined
}

export async function cloneSession(
  state: LanguageModelState,
): Promise<SessionLike> {
  if (state.cloneCapable && typeof state.session.clone === 'function') {
    return state.session.clone()
  }
  return state.session
}

export async function createGeminiNanoModel(
  options: CreateSessionOptions = {},
): Promise<LocaiModel> {
  const state = await createLanguageModel(options)
  return createModelFromState(state)
}

export async function createLocaiModel(
  options: CreateLocaiModelOptions = {},
): Promise<LocaiModel> {
  const opts = { __proto__: null, ...options } as typeof options
  const backend = await selectBackend({
    backend: opts.backend,
    probe: opts.probe,
  })
  const factory = await backend.languageModel()
  const session = await createWithFallback(factory, opts)
  const state: LanguageModelState = {
    cloneCapable: typeof session.clone === 'function',
    namespace: 'modern',
    session,
  }
  return createModelFromState(state)
}

export function createModelFromState(state: LanguageModelState): LocaiModel {
  return {
    async promptStructured<T>(
      userContent: string,
      structuredOptions: StructuredPromptOptions<T>,
    ): Promise<TaskResult<T>> {
      const session = await cloneSession(state)
      try {
        return await promptStructured(session, userContent, structuredOptions)
      } finally {
        destroySession(session)
      }
    },

    async promptStreaming(
      userContent: string,
      streamOptions: StreamOptions = {},
    ): Promise<{ raw: string }> {
      const session = await cloneSession(state)
      try {
        const messages: Message[] = [{ content: userContent, role: 'user' }]
        const result = await streamPrompt(session, messages, streamOptions)
        return { raw: result.raw }
      } finally {
        destroySession(session)
      }
    },

    rawSession(): SessionLike {
      return state.session
    },
  }
}

export function destroySession(session: SessionLike): void {
  if (typeof session.destroy === 'function') {
    session.destroy()
  }
}
