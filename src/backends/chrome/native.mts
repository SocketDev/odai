import type {
  LanguageModelLike,
  Message,
  SessionContextStatus,
  SessionLike,
} from '../../types.mts'

export interface NativeChromeSession {
  addEventListener?(name: string, listener: () => void): void
  clone?(): NativeChromeSession | Promise<NativeChromeSession>
  readonly contextUsage?: number | undefined
  readonly contextWindow?: number | undefined
  destroy?(): void
  prompt(
    messages: Message[],
    options?:
      | {
          responseConstraint?: object | undefined
          signal?: AbortSignal | undefined
        }
      | undefined,
  ): Promise<string>
  promptStreaming(
    messages: Message[],
    options?: { signal?: AbortSignal | undefined } | undefined,
  ): AsyncIterable<string> | ReadableStream<string>
  removeEventListener?(name: string, listener: () => void): void
}

export interface NativeChromeFactory {
  availability(): Promise<string> | { availability: string }
  create(options?: object | undefined): Promise<NativeChromeSession>
}

export function wrapNativeChromeFactory(
  model: NativeChromeFactory,
): LanguageModelLike {
  return {
    contextMode: 'native',
    availability: () => model.availability(),
    async create(options?: object | undefined): Promise<SessionLike> {
      const opts = { __proto__: null, ...options } as {
        abortSignal?: AbortSignal | undefined
      }
      const { abortSignal, ...nativeOptions } = opts
      abortSignal?.throwIfAborted()
      const session = await model.create(
        abortSignal === undefined
          ? nativeOptions
          : { ...nativeOptions, signal: abortSignal },
      )
      if (abortSignal?.aborted === true) {
        session.destroy?.()
        throw abortSignal.reason
      }
      return wrapNativeChromeSession(session)
    },
  }
}

export function wrapNativeChromeSession(
  session: NativeChromeSession,
  wrapOptions?: { overflowed?: boolean | undefined } | undefined,
): SessionLike {
  const initial = { __proto__: null, ...wrapOptions } as typeof wrapOptions
  let overflowed = initial?.overflowed === true
  let destroyed = false
  function assertOpen(): void {
    if (destroyed) {
      throw new DOMException('Session destroyed', 'InvalidStateError')
    }
  }
  const onOverflow = (): void => {
    overflowed = true
  }
  session.addEventListener?.('contextoverflow', onOverflow)
  const wrapped: SessionLike = {
    contextStatus(): SessionContextStatus {
      assertOpen()
      return {
        contextUsage: session.contextUsage,
        contextWindow: session.contextWindow,
        overflowed,
      }
    },
    async prompt(messages, options): Promise<string> {
      assertOpen()
      const opts = { __proto__: null, ...options } as typeof options
      const signal = opts?.abortSignal
      if (signal?.aborted === true) {
        return Promise.reject(signal.reason)
      }
      if (opts?.responseConstraint === undefined && signal === undefined) {
        return session.prompt(messages)
      }
      return session.prompt(messages, {
        responseConstraint: opts?.responseConstraint,
        signal,
      })
    },
    promptStreaming(
      messages,
      options,
    ): AsyncIterable<string> | ReadableStream<string> {
      assertOpen()
      const opts = { __proto__: null, ...options } as typeof options
      const signal = opts?.abortSignal
      signal?.throwIfAborted()
      return signal === undefined
        ? session.promptStreaming(messages)
        : session.promptStreaming(messages, { signal })
    },
    destroy(): void {
      if (destroyed) {
        return
      }
      destroyed = true
      session.removeEventListener?.('contextoverflow', onOverflow)
      session.destroy?.()
    },
  }
  if (typeof session.clone === 'function') {
    wrapped.clone = async (): Promise<SessionLike> => {
      assertOpen()
      const clone = await session.clone!()
      if (destroyed) {
        clone.destroy?.()
        throw new DOMException('Source session destroyed', 'InvalidStateError')
      }
      return wrapNativeChromeSession(clone, { overflowed })
    }
  }
  return wrapped
}
