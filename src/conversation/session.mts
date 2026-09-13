import type { Message, SessionContextStatus, SessionLike } from '../types.mts'
import {
  assertConversationOperation,
  discardConversationSession,
  waitForConversation,
} from './state.mts'
import {
  assertConversationInput,
  assertConversationResponse,
  ConversationError,
  copyConversationMessages,
} from './transcript.mts'
import type {
  ConversationOperation,
  ConversationSession,
  ConversationState,
} from './types.mts'

export interface ConversationTurn<T> {
  commit: boolean
  raw: string
  value: T
}

export async function acquireConversationSession(
  state: ConversationState,
  operation: ConversationOperation,
): Promise<ConversationSession> {
  assertConversationOperation(state, operation)
  if (state.mode === 'native' && state.session !== undefined) {
    return state.session
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort(operation.signal.reason)
  operation.signal.addEventListener('abort', abort, { once: true })
  const options = {
    abortSignal: controller.signal,
    ...(state.mode === 'native'
      ? { initialPrompts: copyConversationMessages(state.messages) }
      : {}),
    ...(state.temperature === undefined
      ? {}
      : { temperature: state.temperature }),
    ...(state.topK === undefined ? {} : { topK: state.topK }),
  }
  let received: ConversationSession | undefined
  let abandoned = false
  const pending = Promise.resolve().then(() => {
    operation.signal.throwIfAborted()
    return state.factory.create(options)
  })
  pending.then(
    session => {
      received = { disposed: false, session }
      if (abandoned) {
        discardConversationSession(state, received)
      }
    },
    () => undefined,
  )
  try {
    await waitForConversation(pending, operation.signal)
    assertConversationOperation(state, operation)
    state.session = received!
    return received!
  } catch (error) {
    abandoned = true
    discardConversationSession(state, received)
    throw error
  } finally {
    operation.signal.removeEventListener('abort', abort)
  }
}

export function isConversationContextCount(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  )
}

export async function readConversationContext(
  state: ConversationState,
  owned: ConversationSession | undefined,
  operation: ConversationOperation,
): Promise<SessionContextStatus> {
  if (state.mode === 'replay' || owned === undefined) {
    return { overflowed: false }
  }
  if (typeof owned.session.contextStatus !== 'function') {
    throw new ConversationError(
      'CONVERSATION_CONTEXT',
      'Native conversation sessions must expose contextStatus() to report lost history.',
    )
  }
  const status = await waitForConversation(
    Promise.resolve().then(() => owned.session.contextStatus!()),
    operation.signal,
  )
  assertConversationOperation(state, operation)
  if (
    status === null ||
    typeof status !== 'object' ||
    typeof status.overflowed !== 'boolean' ||
    !isConversationContextCount(status.contextUsage) ||
    !isConversationContextCount(status.contextWindow)
  ) {
    throw new ConversationError(
      'CONVERSATION_CONTEXT',
      'Native contextStatus() returned an invalid overflow status.',
    )
  }
  if (
    status.overflowed ||
    (status.contextUsage !== undefined &&
      status.contextWindow !== undefined &&
      status.contextUsage > status.contextWindow)
  ) {
    throw new ConversationError(
      'CONVERSATION_OVERFLOW',
      'The native session lost conversation history. Reset the conversation or provide a shorter initial transcript.',
    )
  }
  return status
}

export async function runConversationTurn<T>(
  state: ConversationState,
  operation: ConversationOperation,
  content: string,
  generate: (
    session: SessionLike,
    messages: Message[],
    remaining: number,
  ) => Promise<ConversationTurn<T>>,
): Promise<T> {
  assertConversationOperation(state, operation)
  assertConversationInput(
    content,
    state.limits.maxCharacters - state.characters,
  )
  if (state.turns >= state.limits.maxTurns) {
    throw new ConversationError(
      'CONVERSATION_LIMIT',
      'Conversation maxTurns has been reached. Reset the conversation to continue.',
    )
  }
  let owned: ConversationSession | undefined
  try {
    owned = await acquireConversationSession(state, operation)
    assertConversationOperation(state, operation)
    await readConversationContext(state, owned, operation)
    const messages: Message[] =
      state.mode === 'native' ? [] : copyConversationMessages(state.messages)
    messages.push({ role: 'user', content })
    const remaining =
      state.limits.maxCharacters - state.characters - content.length
    const result = await waitForConversation(
      generate(owned.session, messages, remaining),
      operation.signal,
    )
    assertConversationOperation(state, operation)
    if (result.raw.length > remaining) {
      throw new ConversationError(
        'CONVERSATION_LIMIT',
        'The reply exceeds maxCharacters. The failed turn was not saved.',
      )
    }
    if (!result.commit) {
      discardConversationSession(state, owned)
      return result.value
    }
    assertConversationResponse(result.raw)
    await readConversationContext(state, owned, operation)
    assertConversationOperation(state, operation)
    state.messages.push(
      { role: 'user', content },
      { role: 'assistant', content: result.raw },
    )
    state.characters += content.length + result.raw.length
    state.turns += 1
    return result.value
  } catch (error) {
    discardConversationSession(state, owned)
    throw error
  } finally {
    if (state.mode === 'replay') {
      discardConversationSession(state, owned)
    }
  }
}
