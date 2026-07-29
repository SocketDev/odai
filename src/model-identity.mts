/**
 * @file Best-effort probe for the on-device model's identity. Chrome's built-in
 *   AI Prompt API exposes no model-name field, so this asks the model directly
 *   ("What model are you?") and matches known families in the reply — the same
 *   move the Chrome On-Device Internals playground makes. It is a HEURISTIC: a
 *   model can misreport its own name, so treat the result as a hint, not an
 *   authority. Ordered most-specific first, so "Gemma 4" wins over bare
 *   "Gemma".
 */

import type { Message, SessionLike } from './types.mts'

export interface ModelIdentity {
  /**
   * Canonical model name when a known family matched the reply, else undefined.
   */
  name: string | undefined
  /**
   * The raw model reply, kept for diagnostics and for callers that want to
   * apply their own matching.
   */
  raw: string
}

export const IDENTITY_PROMPT =
  'What model are you? Answer with just the model name.'

const KNOWN_MODELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/gemma\s*4/i, 'Gemma 4'],
  [/gemma/i, 'Gemma'],
  [/gemini\s*nano/i, 'Gemini Nano'],
  [/gemini/i, 'Gemini'],
]

/**
 * Ask a live session which model it is and match the reply. The returned
 * `name` is undefined when the reply names no known family. Errors from the
 * session propagate — a caller that treats identity as optional should catch.
 */
export async function detectModelName(
  session: SessionLike,
): Promise<ModelIdentity> {
  const messages: Message[] = [{ content: IDENTITY_PROMPT, role: 'user' }]
  const raw = await session.prompt(messages)
  return { name: matchModelName(raw), raw }
}

/**
 * Match a known on-device model family in a free-text reply. Returns the
 * canonical name of the first (most-specific) family that matches, or undefined
 * when none is recognized.
 */
export function matchModelName(reply: string): string | undefined {
  for (let i = 0, { length } = KNOWN_MODELS; i < length; i += 1) {
    const [pattern, name] = KNOWN_MODELS[i]!
    if (pattern.test(reply)) {
      return name
    }
  }
  return undefined
}
