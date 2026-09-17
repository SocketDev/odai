import { selectBackend } from '../backends/registry.mts'
import type { OdaiBackend } from '../backends/types.mts'
import { createConversation } from './create.mts'
import { waitForConversation } from './state.mts'
import {
  normalizeConversationInitial,
  normalizeConversationLimits,
} from './transcript.mts'
import type { Conversation, OdaiConversationOptions } from './types.mts'

export function closeConversationBackend(
  backend: OdaiBackend | undefined,
): void {
  if (
    backend !== undefined &&
    'close' in backend &&
    typeof backend.close === 'function'
  ) {
    try {
      void Promise.resolve(backend.close()).catch(() => undefined)
    } catch {
      /* Backend cleanup must preserve the conversation error. */
    }
  }
}

export async function createOdaiConversation(
  options: OdaiConversationOptions = {},
): Promise<Conversation> {
  const opts = { __proto__: null, ...options } as typeof options
  const signal = opts.abortSignal ?? new AbortController().signal
  signal.throwIfAborted()
  opts.initialPrompts = normalizeConversationInitial(
    opts,
    normalizeConversationLimits(opts),
  )
  opts.probe = opts.probe === undefined ? undefined : [...opts.probe]
  const ownedBackend = typeof opts.backend !== 'object'
  let backend: OdaiBackend | undefined
  let abandoned = false
  const selected = selectBackend(opts)
  selected.then(
    value => {
      backend = value
      if (abandoned && ownedBackend) {
        closeConversationBackend(backend)
      }
    },
    () => undefined,
  )
  try {
    backend = await waitForConversation(selected, signal)
    const factory = await waitForConversation(backend.languageModel(), signal)
    const conversation = await createConversation(factory, opts)
    if (!ownedBackend) {
      return conversation
    }
    return ownConversationBackend(conversation, backend, signal)
  } catch (error) {
    abandoned = true
    if (ownedBackend) {
      closeConversationBackend(backend)
    }
    throw error
  }
}

export function ownConversationBackend(
  conversation: Conversation,
  backend: OdaiBackend,
  signal: AbortSignal,
): Conversation {
  let closed = false
  const destroy = (): void => {
    if (closed) {
      return
    }
    closed = true
    conversation.destroy()
    signal.removeEventListener('abort', destroy)
    closeConversationBackend(backend)
  }
  signal.addEventListener('abort', destroy, { once: true })
  if (signal.aborted) {
    destroy()
    signal.throwIfAborted()
  }
  return { ...conversation, destroy }
}
