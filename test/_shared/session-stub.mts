/**
 * @file A `SessionLike` built from the parts a test cares about. Every session
 *   the library accepts must answer `promptStreaming`, and most tests only care
 *   about `prompt`, so writing the object literal inline means restating an
 *   empty async generator at each site. This fills the rest.
 */

import type { Message, SessionLike } from '../../src/types.mts'

export interface SessionStubParts {
  clone?: (() => SessionLike | Promise<SessionLike>) | undefined
  destroy?: (() => void) | undefined
  prompt?: ((messages: Message[]) => Promise<string>) | undefined
  promptStreaming?: ((messages: Message[]) => AsyncIterable<string>) | undefined
}

/**
 * A session answering exactly what the caller supplies, with the remainder
 * filled: `prompt` resolves to the empty string and `promptStreaming` yields
 * nothing, which is what a test that never reads them expects. `clone` and
 * `destroy` stay absent unless given, since the library branches on their
 * presence.
 */
export function stubSession(parts: SessionStubParts = {}): SessionLike {
  const opts = { __proto__: null, ...parts } as SessionStubParts
  return {
    ...(opts.clone === undefined ? {} : { clone: opts.clone }),
    ...(opts.destroy === undefined ? {} : { destroy: opts.destroy }),
    prompt: opts.prompt ?? (async () => ''),
    promptStreaming:
      opts.promptStreaming ??
      (() => (async function* generate(): AsyncGenerator<string> {})()),
  }
}
