/**
 * @file Shared types for the Gemini Nano Prompt API library. The public surface
 *   is intentionally small: a session-like adapter, a message shape, and task
 *   options that work in both browser and Node.
 */

/**
 * A single conversational turn. Mirrors the Prompt API's message shape but is
 * owned here so the Node mock and browser paths stay aligned.
 */
export interface Message {
  content: string
  role: 'assistant' | 'system' | 'user'
}

/**
 * A Prompt API session stripped to the operations this library uses. Browser
 * sessions implement this natively; the Node mock implements it
 * deterministically.
 */
export interface SessionLike {
  clone?(): SessionLike | Promise<SessionLike>
  destroy?(): void
  prompt(
    messages: Message[],
    options?: { responseConstraint?: object | undefined } | undefined,
  ): Promise<string>
  promptStreaming(
    messages: Message[],
  ): AsyncIterable<string> | ReadableStream<string>
}

/**
 * A factory that can create sessions. The browser's stable `LanguageModel`
 * global conforms to this shape.
 */
export interface LanguageModelLike {
  availability(): Promise<string> | { availability: string }
  create(options?: object | undefined): Promise<SessionLike>
}

export interface PromptOptions {
  abortSignal?: AbortSignal | undefined
  initialPrompts?: Message[] | undefined
  /**
   * Optional callback invoked as soon as a parseable early field is seen during
   * streaming. Receives the partial raw response and the parsed value.
   */
  onEarlyField?:
    | ((field: { name: string; raw: string; value: unknown }) => void)
    | undefined
  /**
   * A JSON Schema passed to a backend that supports constrained decoding
   * (Chrome's Prompt API `responseConstraint`). Backends that cannot honor it
   * ignore the option; the Chrome backends feature-detect it and fall back to
   * an unconstrained prompt. A TypeBox schema is valid JSON Schema, so a task
   * can pass its own `Type.Object(...)` here.
   */
  responseConstraint?: object | undefined
  systemPrompt?: string | undefined
  temperature?: number | undefined
  topK?: number | undefined
}

// Published API shape; renaming the exported interface or reshaping the
// bag is a breaking change.
export interface StructuredPromptOptions<T> extends PromptOptions {
  // oxlint-disable-next-line socket/no-required-in-options-bag -- public API
  prefill: string
  /**
   * How many times to re-prompt when the reply is empty or unparseable. Total
   * attempts are `retries + 1`; a small on-device model drops an empty or
   * malformed first reply often enough that one deterministic re-ask recovers
   * most of them. Defaults to 2 (up to 3 attempts).
   */
  retries?: number | undefined
  // oxlint-disable-next-line socket/no-required-in-options-bag -- public API
  schema: SchemaLike<T>
  synonymMap?: Record<string, string[]> | undefined
}

export interface SchemaLike<T> {
  parse(value: unknown): T
}

export interface TaskResult<T> {
  data?: T | undefined
  error?: string | undefined
  ok: boolean
  raw: string
}

export interface LanguageModelState {
  cloneCapable: boolean
  namespace: 'modern' | 'none'
  session: SessionLike
}
