/**
 * @file Hold a warm base session and clone or recreate a session per request.
 *   Request cleanup preserves the base session for the model's owner.
 *   `createOdaiModel` builds the wrapper on any registry backend;
 *   `createBuiltinModel` is the browser-direct entry bound to the runtime's
 *   built-in `LanguageModel` global — no backend registry, so a browser bundle
 *   never pulls in the Node-only backends.
 */

import { awaitCancellable } from './cancellation.mts'

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
  interactive?: boolean | undefined
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
  createSession?: (() => Promise<SessionLike>) | undefined,
): Promise<SessionLike> {
  if (state.cloneCapable && typeof state.session.clone === 'function') {
    return state.session.clone()
  }
  return createSession === undefined ? state.session : createSession()
}

export async function createBuiltinModel(
  options: CreateSessionOptions = {},
): Promise<OdaiModel> {
  const state = await createLanguageModel(options)
  return createModelFromState(
    state,
    async () => (await createLanguageModel(options)).session,
  )
}

export function createModelFromState(
  state: LanguageModelState,
  createSession?: (() => Promise<SessionLike>) | undefined,
  abortSignal?: AbortSignal | undefined,
): OdaiModel {
  function disposeClone(session: SessionLike): void {
    if (session !== state.session) {
      destroySession(session)
    }
  }
  return {
    async promptStructured<T>(
      userContent: string,
      structuredOptions: StructuredPromptOptions<T>,
    ): Promise<TaskResult<T>> {
      const opts = {
        __proto__: null,
        ...structuredOptions,
      } as StructuredPromptOptions<T>
      const signal =
        abortSignal === undefined
          ? opts.abortSignal
          : opts.abortSignal === undefined
            ? abortSignal
            : AbortSignal.any([abortSignal, opts.abortSignal])
      signal?.throwIfAborted()
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
        signal?.throwIfAborted()
        const session = await awaitCancellable(
          cloneSession(state, createSession),
          signal,
          disposeClone,
        )
        try {
          last = await awaitCancellable(
            promptStructured(session, userContent, {
              ...opts,
              abortSignal: signal,
              retries: 0,
            }),
            signal,
          )
        } finally {
          if (session !== state.session) {
            destroySession(session)
          }
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
      const signal =
        abortSignal === undefined
          ? streamOptions.abortSignal
          : streamOptions.abortSignal === undefined
            ? abortSignal
            : AbortSignal.any([abortSignal, streamOptions.abortSignal])
      signal?.throwIfAborted()
      const session = await awaitCancellable(
        cloneSession(state, createSession),
        signal,
        disposeClone,
      )
      try {
        const messages: Message[] = [{ content: userContent, role: 'user' }]
        const result = await awaitCancellable(
          streamPrompt(session, messages, {
            ...streamOptions,
            abortSignal: signal,
          }),
          signal,
        )
        return { raw: result.raw }
      } finally {
        if (session !== state.session) {
          destroySession(session)
        }
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
  opts.abortSignal?.throwIfAborted()
  const backend = await awaitCancellable(
    selectBackend({
      backend: opts.backend,
      probe: opts.probe,
      abortSignal: opts.abortSignal,
      interactive: opts.interactive,
    }),
    opts.abortSignal,
  )
  const factory = await awaitCancellable(
    backend.languageModel(),
    opts.abortSignal,
  )
  const session = await awaitCancellable(
    createWithFallback(factory, opts),
    opts.abortSignal,
    destroySession,
  )
  const state: LanguageModelState = {
    backendName: backend.name,
    cloneCapable: typeof session.clone === 'function',
    namespace: 'modern',
    session,
  }
  const createSession = () => createWithFallback(factory, opts)
  try {
    if (!opts.interactive) {
      state.modelName = await awaitCancellable(
        detectSessionModelName(state, createSession),
        opts.abortSignal,
      )
    }
    return createModelFromState(state, createSession, opts.abortSignal)
  } catch (error) {
    destroySession(session)
    throw error
  }
}

export function destroySession(session: SessionLike): void {
  if (typeof session.destroy === 'function') {
    session.destroy()
  }
}

export function detectSessionModelName(
  state: LanguageModelState,
  createSession: () => Promise<SessionLike>,
  timeoutMs = 5000,
): Promise<string | undefined> {
  return new Promise(resolve => {
    let probe: SessionLike | undefined
    let settled = false
    const finish = (name?: string | undefined): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (probe !== undefined && probe !== state.session) {
        destroySession(probe)
      }
      resolve(name)
    }
    const timer = setTimeout(() => finish(), timeoutMs)
    cloneSession(state, createSession).then(
      session => {
        probe = session
        if (settled) {
          if (session !== state.session) {
            destroySession(session)
          }
          return
        }
        detectModelName(session).then(
          identity => finish(identity.name),
          () => finish(),
        )
      },
      () => finish(),
    )
  })
}
