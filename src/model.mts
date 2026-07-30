/**
 * @file High-level model wrapper. Holds a warm base session, clones it per
 *   request, and destroys the clone afterwards. This avoids the state-growth
 *   gotcha where every prompt appends to the same conversation history.
 *   `createOdaiModel` builds the wrapper on any registry backend;
 *   `createBuiltinModel` is the browser-direct entry bound to the runtime's
 *   built-in `LanguageModel` global — no backend registry, so a browser bundle
 *   never pulls in the Node-only backends.
 */

import { selectBackend } from './backends/registry.mts'
import { promptStructured } from './json.mts'
import { createLanguageModel, createWithFallback } from './session.mts'
import { streamPrompt } from './stream.mts'
import type { BackendName, OdaiBackend } from './backends/types.mts'
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

export interface OdaiModel {
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

export interface CreateOdaiModelOptions extends CreateSessionOptions {
  /**
   * Explicit backend: a registry name or a caller-built `OdaiBackend`.
   * Selection precedence when omitted: `ODAI_BACKEND` env var, then the
   * availability probe order.
   */
  backend?: BackendName | OdaiBackend | undefined
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

export async function createBuiltinModel(
  options: CreateSessionOptions = {},
): Promise<OdaiModel> {
  const state = await createLanguageModel(options)
  return createModelFromState(state)
}

export function createModelFromState(state: LanguageModelState): OdaiModel {
  return {
    async promptStructured<T>(
      userContent: string,
      structuredOptions: StructuredPromptOptions<T>,
    ): Promise<TaskResult<T>> {
      const opts = {
        __proto__: null,
        ...structuredOptions,
      } as StructuredPromptOptions<T>
      const attempts = (opts.retries ?? 2) + 1
      // Retry with a FRESH cloned session per attempt. A stateful backend
      // (Chrome's Nano) rejects a re-sent system message on an already-used
      // session, so re-prompting the same clone is invalid — each attempt gets
      // its own clone and a single json-layer pass (retries: 0).
      let last: TaskResult<T> = {
        error: 'model returned no parseable response',
        ok: false,
        raw: '',
      }
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const session = await cloneSession(state)
        try {
          last = await promptStructured(session, userContent, {
            ...opts,
            retries: 0,
          })
        } finally {
          destroySession(session)
        }
        if (last.ok) {
          return last
        }
      }
      return last
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

export async function createOdaiModel(
  options: CreateOdaiModelOptions = {},
): Promise<OdaiModel> {
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

export function destroySession(session: SessionLike): void {
  if (typeof session.destroy === 'function') {
    session.destroy()
  }
}
