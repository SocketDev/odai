/**
 * @file Node entry point. The Prompt API is browser-only, so this entry exports
 *   a deterministic mock session and all task helpers. Tests and CLI tools can
 *   run without Chrome; only the browser entry wires the real `LanguageModel`.
 */

import { promptStructured } from './json.mts'
import { dedupeDependencies } from './tasks/dedupe.mts'
import { reasonAboutLockfile } from './tasks/lockfile.mts'
import { generateCodePatch } from './tasks/patch.mts'
import type { GeminiNanoModel } from './model.mts'
import type {
  Message,
  SessionLike,
  StructuredPromptOptions,
  TaskResult,
} from './types.mts'
import type { StreamOptions } from './stream.mts'

export function createMockModel(response: string): GeminiNanoModel {
  const session = createMockSession({ response })
  return {
    async promptStructured<T>(
      userContent: string,
      options: StructuredPromptOptions<T>,
    ): Promise<TaskResult<T>> {
      return promptStructured(session, userContent, options)
    },
    async promptStreaming(
      _userContent: string,
      _options?: StreamOptions | undefined,
    ): Promise<{ raw: string }> {
      return { raw: response }
    },
    rawSession(): SessionLike {
      return session
    },
  }
}

export interface MockSessionOptions {
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

export { dedupeDependencies, generateCodePatch, reasonAboutLockfile }
