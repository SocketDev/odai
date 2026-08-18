/**
 * @file High-level model wrapper. Holds a warm base session, clones it per
 *   request, and destroys the clone afterwards. This avoids the state-growth
 *   gotcha where every prompt appends to the same conversation history.
 *   `createOdaiModel` builds the wrapper on any registry backend;
 *   `createBuiltinModel` is the browser-direct entry bound to the runtime's
 *   built-in `LanguageModel` global — no backend registry, so a browser bundle
 *   never pulls in the Node-only backends.
 */

import { detectModelName } from './model-identity.mts'
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
          break
        }
      }
      // Stamp the producing model so a verdict's origin is reproducible by
      // every consumer: the detected model identity (cached at creation)
      // with the backend's registry name as the fallback; absent for
      // caller-built models.
      const stamp = state.modelName ?? state.backendName
      if (stamp !== undefined && last.model === undefined) {
        last.model = stamp
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
  // Query the model's identity once at creation and cache it on the state,
  // at the cost of one extra prompt. The weights behind a backend change
  // over time (Gemini Nano today, Gemma 4 later), so the stamp names the
  // model, not the host. Detection failure is silent - the backend name
  // remains the fallback.
  // Timeout-bounded: a hanging or slow backend degrades to the registry
  // fallback in 5s instead of stalling model creation forever. Single-shot
  // deadline wrapper (not Promise.race): the winner's handler clears the
  // timer, and a late probe settles into an already-resolved outer promise
  // instead of attaching unbounded handlers per call.
  const modelName = await new Promise<string | undefined>(resolve => {
    const timer = setTimeout(() => resolve(undefined), 5000)
    detectModelName(session).then(
      identity => {
        clearTimeout(timer)
        resolve(identity.name)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
  const state: LanguageModelState = {
    backendName: backend.name,
    cloneCapable: typeof session.clone === 'function',
    modelName,
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
