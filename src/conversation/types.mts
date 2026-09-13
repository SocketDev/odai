import type { BackendName, OdaiBackend } from '../backends/types.mts'
import type { StreamOptions, StreamResult } from '../stream.mts'
import type {
  LanguageModelLike,
  Message,
  SchemaLike,
  SessionContextStatus,
  SessionLike,
  TaskResult,
} from '../types.mts'

export interface ConversationOptions {
  abortSignal?: AbortSignal | undefined
  initialPrompts?: readonly Message[] | undefined
  maxCharacters?: number | undefined
  maxTurns?: number | undefined
  systemPrompt?: string | undefined
  temperature?: number | undefined
  topK?: number | undefined
}

export interface OdaiConversationOptions extends ConversationOptions {
  backend?: BackendName | OdaiBackend | undefined
  probe?: readonly BackendName[] | undefined
}

export interface ConversationPromptOptions {
  abortSignal?: AbortSignal | undefined
}

export interface ConversationStructuredOptions<
  T,
> extends ConversationPromptOptions {
  prefill?: string | undefined
  responseConstraint?: object | undefined
  retries?: number | undefined
  // oxlint-disable-next-line socket/no-required-in-options-bag -- output contract
  schema: SchemaLike<T>
  // oxlint-disable-next-line socket/prefer-refined-record -- open key set
  synonymMap?: Record<string, string[]> | undefined
}

export interface ConversationChunk {
  chunk: string
  raw: string
}

export interface ConversationStreamOptions extends StreamOptions {
  onChunk?: ((chunk: ConversationChunk) => void) | undefined
}

export interface ConversationStatus extends SessionContextStatus {
  characters: number
  maxCharacters: number
  maxTurns: number
  mode: 'native' | 'replay'
  turns: number
}

export interface Conversation {
  contextStatus(): Promise<ConversationStatus>
  destroy(): void
  messages(): Message[]
  prompt(
    content: string,
    options?: ConversationPromptOptions | undefined,
  ): Promise<string>
  promptStructured<T>(
    content: string,
    options: ConversationStructuredOptions<T>,
  ): Promise<TaskResult<T>>
  promptStreaming(
    content: string,
    options?: ConversationStreamOptions | undefined,
  ): Promise<StreamResult>
  reset(initialPrompts?: readonly Message[] | undefined): void
}

export interface ConversationLimits {
  maxCharacters: number
  maxTurns: number
}

export interface ConversationSession {
  disposed: boolean
  session: SessionLike
}

export interface ConversationOperation {
  generation: number
  signal: AbortSignal
}

export interface ConversationState {
  characters: number
  closed: boolean
  controller: AbortController
  detachOwner: (() => void) | undefined
  factory: LanguageModelLike
  generation: number
  initial: Message[]
  limits: ConversationLimits
  messages: Message[]
  mode: 'native' | 'replay'
  pendingTurns: number
  session: ConversationSession | undefined
  tail: Promise<void>
  temperature: number | undefined
  topK: number | undefined
  turns: number
}
