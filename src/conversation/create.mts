import type { LanguageModelLike } from '../types.mts'
import {
  assertConversationTurnOptions,
  promptConversationStructured,
  readConversationStream,
} from './response.mts'
import { readConversationContext, runConversationTurn } from './session.mts'
import {
  assertConversationOpen,
  createConversationState,
  destroyConversationState,
  discardConversationSession,
  enqueueConversation,
  resetConversationState,
  waitForConversation,
} from './state.mts'
import {
  assertConversationInput,
  copyConversationMessages,
} from './transcript.mts'
import type {
  Conversation,
  ConversationOptions,
  ConversationState,
  ConversationStreamOptions,
  ConversationStructuredOptions,
} from './types.mts'

export async function conversationStatus(state: ConversationState) {
  return await enqueueConversation(
    state,
    undefined,
    async operation => {
      const owned = state.session
      try {
        const native = await readConversationContext(state, owned, operation)
        return {
          __proto__: null,
          ...native,
          characters: state.characters,
          maxCharacters: state.limits.maxCharacters,
          maxTurns: state.limits.maxTurns,
          mode: state.mode,
          turns: state.turns,
        }
      } catch (error) {
        discardConversationSession(state, owned)
        throw error
      }
    },
    false,
  )
}

/**
 * Create bounded conversation history without starting a model session.
 */
export async function createConversation(
  factory: LanguageModelLike,
  conversationOptions: ConversationOptions = {},
): Promise<Conversation> {
  const state = createConversationState(factory, { ...conversationOptions })
  return {
    contextStatus: () => conversationStatus(state),
    destroy: () => destroyConversationState(state),
    messages() {
      assertConversationOpen(state)
      return copyConversationMessages(state.messages)
    },
    async prompt(content, options = {}) {
      const opts = { __proto__: null, ...options } as typeof options
      assertConversationTurnOptions(opts)
      assertConversationInput(content, state.limits.maxCharacters)
      return await enqueueConversation(state, opts.abortSignal, operation =>
        runConversationTurn(
          state,
          operation,
          content,
          async (session, messages) => {
            const raw = await waitForConversation(
              session.prompt(messages, { abortSignal: operation.signal }),
              operation.signal,
            )
            return { __proto__: null, commit: true, raw, value: raw }
          },
        ),
      )
    },
    async promptStructured(content, options) {
      const opts = snapshotStructuredOptions(options)
      assertConversationInput(content, state.limits.maxCharacters)
      return await enqueueConversation(state, opts.abortSignal, operation =>
        promptConversationStructured(state, operation, content, opts),
      )
    },
    async promptStreaming(content, options = {}) {
      const opts = snapshotStreamOptions(options)
      assertConversationInput(content, state.limits.maxCharacters)
      return await enqueueConversation(state, opts.abortSignal, operation =>
        runConversationTurn(
          state,
          operation,
          content,
          async (session, messages, remaining) => {
            const value = await readConversationStream(
              session,
              messages,
              opts,
              operation.signal,
              remaining,
            )
            return { __proto__: null, commit: true, raw: value.raw, value }
          },
        ),
      )
    },
    reset: initialPrompts => resetConversationState(state, initialPrompts),
  }
}

export function snapshotStreamOptions(
  options: ConversationStreamOptions,
): ConversationStreamOptions {
  const opts = { __proto__: null, ...options } as typeof options
  assertConversationTurnOptions(opts)
  return {
    ...opts,
    earlyFieldPatterns:
      opts.earlyFieldPatterns === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(opts.earlyFieldPatterns).map(([key, pattern]) => [
              key,
              new RegExp(pattern.source, pattern.flags),
            ]),
          ),
  }
}

export function snapshotStructuredOptions<T>(
  options: ConversationStructuredOptions<T>,
): ConversationStructuredOptions<T> {
  const opts = { __proto__: null, ...options } as typeof options
  assertConversationTurnOptions(opts)
  if (typeof opts.schema?.parse !== 'function') {
    throw new TypeError(
      'Structured conversation requests require a schema parser.',
    )
  }
  return {
    ...opts,
    responseConstraint:
      opts.responseConstraint === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(opts.responseConstraint)) as object),
    schema: { parse: opts.schema.parse.bind(opts.schema) },
    synonymMap:
      opts.synonymMap === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(opts.synonymMap).map(([key, values]) => [
              key,
              [...values],
            ]),
          ),
  }
}
