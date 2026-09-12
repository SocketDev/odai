import { promptStructured } from './json.mts'
import type { OdaiModel } from './model.mts'
import type {
  Message,
  SessionLike,
  StructuredPromptOptions,
  TaskResult,
} from './types.mts'
import type { StreamOptions } from './stream.mts'

export function createMockModel(response: string): OdaiModel {
  const session = createMockSession({ response })
  return {
    async promptStructured<T>(
      userContent: string,
      options: StructuredPromptOptions<T>,
    ): Promise<TaskResult<T>> {
      return promptStructured(session, userContent, options)
    },
    async promptStreaming(
      userContent: string,
      options?: StreamOptions | undefined,
    ): Promise<{ raw: string }> {
      void userContent
      void options
      return { raw: response }
    },
    rawSession(): SessionLike {
      return session
    },
  }
}

// Published API shape; renaming the exported interface or reshaping the
// bag is a breaking change.
export interface MockSessionOptions {
  // oxlint-disable-next-line socket/no-required-in-options-bag -- public API
  response: string
}

export function createMockSession(options: MockSessionOptions): SessionLike {
  const opts = { __proto__: null, ...options } as typeof options
  return {
    async prompt(messages: Message[]): Promise<string> {
      void messages
      return opts.response
    },
    promptStreaming(): AsyncIterable<string> {
      return (async function* generate(): AsyncGenerator<string> {
        yield opts.response
      })()
    },
  }
}
