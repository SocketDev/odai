import { getLanguageModel } from '../builtin-availability.mts'
import { createConversation } from './create.mts'
import type { Conversation, ConversationOptions } from './types.mts'

export async function createBuiltinConversation(
  options: ConversationOptions = {},
): Promise<Conversation> {
  const opts = { __proto__: null, ...options } as typeof options
  opts.abortSignal?.throwIfAborted()
  const factory = getLanguageModel()
  if (factory === undefined) {
    throw new Error('No builtin language model is available in this runtime.')
  }
  return await createConversation(factory, opts)
}
