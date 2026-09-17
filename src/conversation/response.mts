import { mergePrefill, parseJsonWithFallback } from '../json.mts'
import {
  consumeStream,
  mergeStreamChunk,
  tryExtractEarlyField,
} from '../stream.mts'
import type { StreamResult } from '../stream.mts'
import type { Message, SessionLike, TaskResult } from '../types.mts'
import { assertConversationOperation, waitForConversation } from './state.mts'
import { ConversationError } from './transcript.mts'
import { runConversationTurn } from './session.mts'
import type {
  ConversationOperation,
  ConversationState,
  ConversationStreamOptions,
  ConversationStructuredOptions,
} from './types.mts'

export function assertConversationTurnOptions(options: object): void {
  if ('systemPrompt' in options || 'initialPrompts' in options) {
    throw new TypeError(
      'Set system instructions and initial messages when creating or resetting the conversation.',
    )
  }
}

export async function promptConversationStructured<T>(
  state: ConversationState,
  operation: ConversationOperation,
  content: string,
  options: ConversationStructuredOptions<T>,
): Promise<TaskResult<T>> {
  const opts = { __proto__: null, ...options } as typeof options
  const retries = opts.retries ?? 2
  const prefill = opts.prefill ?? ''
  if (
    !Number.isSafeInteger(retries) ||
    retries < 0 ||
    retries > 5 ||
    typeof prefill !== 'string' ||
    typeof opts.schema?.parse !== 'function'
  ) {
    throw new TypeError(
      'Structured conversation requests need a schema, a string prefill, and 0–5 retries.',
    )
  }
  let last: TaskResult<T> = {
    ok: false,
    raw: '',
    error: 'No structured response was produced.',
  }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    assertConversationOperation(state, operation)
    last = await runConversationTurn(
      state,
      operation,
      content,
      async (session, messages) => {
        if (prefill !== '') {
          messages.push({ role: 'assistant', content: prefill, prefix: true })
        }
        const raw = mergePrefill(
          prefill,
          await waitForConversation(
            session.prompt(messages, {
              abortSignal: operation.signal,
              responseConstraint: opts.responseConstraint,
            }),
            operation.signal,
          ),
        )
        let result: TaskResult<T>
        try {
          const data = parseJsonWithFallback(raw, opts.schema, opts.synonymMap)
          result = { ok: true, raw, data }
        } catch (error) {
          // This path also runs in browsers without Node error helpers.
          let message: string
          if (error instanceof Error) {
            message = error.message
          } else {
            message = String(error)
          }
          result = {
            ok: false,
            raw,
            error: message,
          }
        }
        return { __proto__: null, commit: result.ok, raw, value: result }
      },
    )
    if (last.ok) {
      break
    }
  }
  return last
}

export async function readConversationStream(
  session: SessionLike,
  messages: Message[],
  options: ConversationStreamOptions,
  signal: AbortSignal,
  remaining: number,
): Promise<StreamResult> {
  const opts = { __proto__: null, ...options } as typeof options
  let raw = ''
  let reportedField = false
  if (typeof session.promptStreaming !== 'function') {
    raw = await waitForConversation(
      session.prompt(messages, { abortSignal: signal }),
      signal,
    )
    return { aborted: false, raw, requestId: opts.requestId, stale: false }
  }
  await consumeStream(
    session.promptStreaming(messages, { abortSignal: signal }),
    chunk => {
      raw = mergeStreamChunk(raw, chunk)
      if (raw.length > remaining) {
        throw new ConversationError(
          'CONVERSATION_LIMIT',
          'The streamed reply exceeds maxCharacters. The failed turn was not saved.',
        )
      }
      signal.throwIfAborted()
      opts.onChunk?.({ chunk, raw })
      signal.throwIfAborted()
      if (
        !reportedField &&
        opts.earlyFieldPatterns !== undefined &&
        opts.onEarlyField !== undefined
      ) {
        const field = tryExtractEarlyField(raw, opts.earlyFieldPatterns)
        if (field !== undefined) {
          reportedField = true
          opts.onEarlyField({ name: field.name, value: field.value, raw })
        }
      }
    },
    signal,
  )
  signal.throwIfAborted()
  return { aborted: false, raw, requestId: opts.requestId, stale: false }
}
