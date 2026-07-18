/**
 * @file High-level model wrapper. Holds a warm base session, clones it per
 *   request, and destroys the clone afterwards. This avoids the state-growth
 *   gotcha where every prompt appends to the same conversation history.
 */

import { promptStructured } from './json.mts'
import { createLanguageModel } from './session.mts'
import { streamPrompt } from './stream.mts'
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

export interface GeminiNanoModel {
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
): Promise<GeminiNanoModel> {
  const state = await createLanguageModel(options)

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
