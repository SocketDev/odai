import { vi } from 'vitest'
import type {
  LanguageModelLike,
  Message,
  SessionLike,
} from '../../../../../src/types.mts'

export function conversationFactory(
  mode: 'native' | 'replay' | undefined = 'native',
) {
  const sessions: Array<{
    history: Message[]
    initial: Message[]
    signal: AbortSignal | undefined
    session: SessionLike
  }> = []
  const responses: Array<string | Error | Promise<string>> = []
  const calls: Message[][] = []
  const factory: LanguageModelLike = {
    ...(mode === undefined ? {} : { contextMode: mode }),
    availability: async () => 'available',
    create: vi.fn(async (options?: object) => {
      const opts = (options ?? {}) as {
        abortSignal?: AbortSignal
        initialPrompts?: Message[]
      }
      const initial = structuredClone(opts.initialPrompts ?? [])
      const history = [...initial]
      const session: SessionLike = {
        contextStatus: vi.fn(() => ({
          contextUsage: history.length,
          contextWindow: 1000,
          overflowed: false,
        })),
        destroy: vi.fn(),
        prompt: vi.fn(async messages => {
          calls.push(structuredClone(messages))
          history.push(...messages)
          const next = responses.shift() ?? 'answer'
          if (next instanceof Error) {
            throw next
          }
          const result = await next
          history.push({ role: 'assistant', content: result })
          return result
        }),
        promptStreaming: vi.fn(
          () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue('answer')
                controller.close()
              },
            }),
        ),
      }
      sessions.push({ history, initial, signal: opts.abortSignal, session })
      return session
    }),
  }
  return { calls, factory, responses, sessions }
}

export function conversationTranscript(value = 'earlier'): Message[] {
  return [
    { role: 'system', content: 'instruction' },
    { role: 'user', content: value },
    { role: 'assistant', content: 'previous answer' },
  ]
}
