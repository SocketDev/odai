import type { LanguageModelLike, Message, SessionLike } from '../types.mts'

/**
 * Wrap a native `LanguageModelLike` (the in-browser `LanguageModel` global) so
 * every session it hands out feature-detects `responseConstraint`: the option
 * is forwarded to the native `prompt` when present, and an unsupported-option
 * throw reverts to a plain `prompt(messages)`. Cloned sessions are wrapped the
 * same way so the fallback survives per-request clones. The Node bridge path
 * feature-detects inside Chrome instead (see `pagePrompt`).
 */
export function wrapFactoryWithConstraintFallback(
  model: LanguageModelLike,
): LanguageModelLike {
  return {
    availability(): Promise<string> | { availability: string } {
      return model.availability()
    },
    async create(options?: object | undefined): Promise<SessionLike> {
      return wrapSessionWithConstraintFallback(await model.create(options))
    },
  }
}

export function wrapSessionWithConstraintFallback(
  session: SessionLike,
): SessionLike {
  const wrapped: SessionLike = {
    async prompt(
      messages: Message[],
      options?: { responseConstraint?: object | undefined } | undefined,
    ): Promise<string> {
      const opts = { __proto__: null, ...options } as typeof options
      const responseConstraint = opts?.responseConstraint
      if (responseConstraint !== undefined) {
        try {
          return await session.prompt(messages, { responseConstraint })
        } catch {
          // Unsupported option or a throw — fall back to a plain prompt.
        }
      }
      return session.prompt(messages)
    },
    promptStreaming(
      messages: Message[],
    ): AsyncIterable<string> | ReadableStream<string> {
      return session.promptStreaming(messages)
    },
  }
  if (typeof session.clone === 'function') {
    wrapped.clone = async (): Promise<SessionLike> =>
      wrapSessionWithConstraintFallback(await session.clone!())
  }
  if (typeof session.destroy === 'function') {
    wrapped.destroy = (): void => session.destroy!()
  }
  return wrapped
}
