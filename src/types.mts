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
  prompt(messages: Message[]): Promise<string>
  promptStreaming(
    messages: Message[],
  ): AsyncIterable<string> | ReadableStream<string>
}

/**
 * A factory that can create sessions. The browser's `LanguageModel` global and
 * `window.ai.languageModel` both conform to this shape.
 */
export interface LanguageModelLike {
  availability?(): Promise<string> | { availability: string }
  capabilities?(): Promise<{ available: string }> | { available: string }
  create(options?: object): Promise<SessionLike>
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
  systemPrompt?: string | undefined
  temperature?: number | undefined
  topK?: number | undefined
}

export interface StructuredPromptOptions<T> extends PromptOptions {
  prefill: string
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
  namespace: 'modern' | 'legacy' | 'none'
  session: SessionLike
}
