import type { Message } from '../types.mts'
import type { ConversationLimits, ConversationOptions } from './types.mts'

export class ConversationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ConversationError'
  }
}

export function assertConversationInput(
  content: unknown,
  available: number,
): asserts content is string {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new TypeError('Conversation input must be a nonempty string.')
  }
  if (content.length > available) {
    throw new ConversationError(
      'CONVERSATION_LIMIT',
      'Conversation input exceeds the character limit. Reset the conversation or raise maxCharacters.',
    )
  }
}

export function assertConversationResponse(
  content: unknown,
): asserts content is string {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new ConversationError(
      'CONVERSATION_RESPONSE',
      'The provider returned no complete text response.',
    )
  }
}

export function conversationCharacters(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0)
}

export function conversationTurns(messages: readonly Message[]): number {
  return Math.floor(messages.length / 2)
}

export function copyConversationMessages(
  messages: readonly Message[],
): Message[] {
  return messages.map(message => ({
    __proto__: null,
    content: message.content,
    role: message.role,
  }))
}

export function normalizeConversationInitial(
  options: ConversationOptions,
  limits: ConversationLimits,
): Message[] {
  const opts = { __proto__: null, ...options } as typeof options
  const source = opts.initialPrompts === undefined ? [] : opts.initialPrompts
  if (!Array.isArray(source)) {
    throw new TypeError(
      'Conversation initialPrompts must be an array of completed messages.',
    )
  }
  const messages = validateConversationMessages(source, limits)
  if (opts.systemPrompt !== undefined) {
    if (typeof opts.systemPrompt !== 'string') {
      throw new TypeError('Conversation systemPrompt must be a string.')
    }
    if (messages[0]?.role === 'system') {
      if (messages[0].content !== opts.systemPrompt) {
        throw new TypeError(
          'Conversation systemPrompt conflicts with the first initial prompt.',
        )
      }
    } else {
      messages.unshift({ role: 'system', content: opts.systemPrompt })
    }
  }
  return validateConversationMessages(messages, limits)
}

export function normalizeConversationLimits(
  options: ConversationOptions,
): ConversationLimits {
  const opts = { __proto__: null, ...options } as typeof options
  const maxCharacters = opts.maxCharacters ?? 32_768
  const maxTurns = opts.maxTurns ?? 32
  if (
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters < 1 ||
    !Number.isSafeInteger(maxTurns) ||
    maxTurns < 1
  ) {
    throw new RangeError(
      'Conversation maxCharacters and maxTurns must be positive safe integers.',
    )
  }
  return { maxCharacters, maxTurns }
}

export function validateConversationMessages(
  source: readonly Message[],
  limits: ConversationLimits,
): Message[] {
  if (!Array.isArray(source) || source.length > limits.maxTurns * 2 + 1) {
    throw new ConversationError(
      'CONVERSATION_LIMIT',
      'The initial conversation exceeds maxTurns or is not a message array.',
    )
  }
  let expected: 'user' | 'assistant' = 'user'
  let characters = 0
  const messages: Message[] = []
  for (let index = 0, { length } = source; index < length; index += 1) {
    const message = source[index]
    if (
      message === undefined ||
      message === null ||
      typeof message !== 'object' ||
      typeof message.content !== 'string' ||
      message.prefix === true
    ) {
      throw new TypeError(
        'Initial conversation messages need string content and cannot be partial assistant prefixes.',
      )
    }
    if (index === 0 && message.role === 'system') {
      expected = 'user'
    } else {
      if (message.role !== expected) {
        throw new TypeError(
          'Initial messages must contain one optional system message followed by complete user and assistant pairs.',
        )
      }
      expected = expected === 'user' ? 'assistant' : 'user'
    }
    characters += message.content.length
    if (characters > limits.maxCharacters) {
      throw new ConversationError(
        'CONVERSATION_LIMIT',
        'Initial conversation messages exceed maxCharacters.',
      )
    }
    messages.push({ content: message.content, role: message.role })
  }
  if (expected !== 'user') {
    throw new TypeError(
      'Initial conversation messages must end with a completed assistant reply.',
    )
  }
  return messages
}
