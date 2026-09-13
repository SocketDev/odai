import { awaitStreamValue, STREAM_ABORTED } from '../stream.mts'
import type { LanguageModelLike, Message } from '../types.mts'
import {
  conversationCharacters,
  ConversationError,
  conversationTurns,
  copyConversationMessages,
  normalizeConversationInitial,
  normalizeConversationLimits,
  validateConversationMessages,
} from './transcript.mts'
import type {
  ConversationOperation,
  ConversationOptions,
  ConversationSession,
  ConversationState,
} from './types.mts'

export function assertConversationOpen(state: ConversationState): void {
  if (state.closed) {
    throw new ConversationError(
      'CONVERSATION_CLOSED',
      'This conversation is destroyed. Create a new conversation.',
    )
  }
}

export function assertConversationOperation(
  state: ConversationState,
  operation: ConversationOperation,
): void {
  operation.signal.throwIfAborted()
  assertConversationOpen(state)
  if (state.generation !== operation.generation) {
    throw new DOMException('The conversation was reset.', 'AbortError')
  }
}

export function createConversationState(
  factory: LanguageModelLike,
  options: ConversationOptions,
): ConversationState {
  const opts = { __proto__: null, ...options } as typeof options
  opts.abortSignal?.throwIfAborted()
  const limits = normalizeConversationLimits(options)
  const initial = normalizeConversationInitial(options, limits)
  const state: ConversationState = {
    characters: conversationCharacters(initial),
    closed: false,
    controller: new AbortController(),
    detachOwner: undefined,
    factory,
    generation: 0,
    initial,
    limits,
    messages: copyConversationMessages(initial),
    mode: factory.contextMode === 'native' ? 'native' : 'replay',
    pendingTurns: 0,
    session: undefined,
    tail: Promise.resolve(),
    temperature: opts.temperature,
    topK: opts.topK,
    turns: conversationTurns(initial),
  }
  if (opts.abortSignal !== undefined) {
    const signal = opts.abortSignal
    const abort = (): void => destroyConversationState(state, signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    state.detachOwner = () => signal.removeEventListener('abort', abort)
  }
  return state
}

export function destroyConversationState(
  state: ConversationState,
  reason: unknown = new DOMException(
    'The conversation was destroyed.',
    'AbortError',
  ),
): void {
  if (state.closed) {
    return
  }
  state.closed = true
  state.generation += 1
  state.controller.abort(reason)
  discardConversationSession(state, state.session)
  state.detachOwner?.()
  state.detachOwner = undefined
  state.initial = []
  state.messages = []
  state.characters = 0
  state.turns = 0
  state.pendingTurns = 0
  state.tail = Promise.resolve()
}

export function discardConversationSession(
  state: ConversationState,
  owned: ConversationSession | undefined,
): void {
  if (owned === undefined || owned.disposed) {
    return
  }
  owned.disposed = true
  if (state.session === owned) {
    state.session = undefined
  }
  try {
    owned.session.destroy?.()
  } catch {
    /* Resource cleanup must preserve the operation's result or error. */
  }
}

export function enqueueConversation<T>(
  state: ConversationState,
  signal: AbortSignal | undefined,
  job: (operation: ConversationOperation) => Promise<T>,
  turn = true,
): Promise<T> {
  assertConversationOpen(state)
  signal?.throwIfAborted()
  if (turn && state.turns + state.pendingTurns >= state.limits.maxTurns) {
    throw new ConversationError(
      'CONVERSATION_LIMIT',
      'Conversation maxTurns is reached or reserved by queued turns. Reset the conversation to continue.',
    )
  }
  const operation: ConversationOperation = {
    generation: state.generation,
    signal:
      signal === undefined
        ? state.controller.signal
        : AbortSignal.any([state.controller.signal, signal]),
  }
  if (turn) {
    state.pendingTurns += 1
  }
  const pending = state.tail.then(async () => {
    try {
      assertConversationOperation(state, operation)
      return await job(operation)
    } finally {
      if (turn && state.generation === operation.generation) {
        state.pendingTurns -= 1
      }
    }
  })
  state.tail = pending.then(
    () => undefined,
    () => undefined,
  )
  return waitForConversation(pending, operation.signal)
}

export function resetConversationState(
  state: ConversationState,
  initialPrompts?: readonly Message[] | undefined,
): void {
  assertConversationOpen(state)
  const messages = validateConversationMessages(
    initialPrompts === undefined ? state.initial : initialPrompts,
    state.limits,
  )
  state.generation += 1
  state.controller.abort(
    new DOMException('The conversation was reset.', 'AbortError'),
  )
  discardConversationSession(state, state.session)
  state.controller = new AbortController()
  state.messages = messages
  state.characters = conversationCharacters(messages)
  state.turns = conversationTurns(messages)
  state.pendingTurns = 0
  state.tail = Promise.resolve()
}

export async function waitForConversation<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const value = await awaitStreamValue(pending, signal)
  if (value === STREAM_ABORTED) {
    throw signal.reason
  }
  signal.throwIfAborted()
  return value
}
