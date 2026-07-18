/**
 * @file Node/browser-agnostic simulator of the stable `LanguageModel` Prompt API.
 *   Useful for CI, node-smol SEA builds, and any environment where Chrome's
 *   on-device model is unavailable. The simulator conforms to the same shape as
 *   the browser global so `createGeminiNanoModel` works unchanged.
 */

import type { LanguageModelLike, Message, SessionLike } from './types.mts'

export interface ResponseRule {
  readonly response: string
  readonly when: (text: string) => boolean
}

export interface LanguageModelSimulatorOptions {
  /**
   * Ordered list of rules. The first rule whose `when` predicate returns true
   * determines the response.
   */
  readonly rules?: ResponseRule[] | undefined
  /**
   * Response used when no rule matches.
   */
  readonly fallback?: string | undefined
}

export class LanguageModelSimulator implements LanguageModelLike {
  readonly #fallback: string
  readonly #rules: ResponseRule[]

  constructor(options: LanguageModelSimulatorOptions = {}) {
    const opts = { __proto__: null, ...options } as typeof options
    this.#fallback = opts.fallback ?? '{"summary":"no matching rule"}'
    this.#rules = opts.rules ?? []
  }

  availability(): Promise<'available'> {
    return Promise.resolve('available')
  }

  async create(_options?: object): Promise<SessionLike> {
    return new LanguageModelSessionSimulator(this.#rules, this.#fallback)
  }
}

export class LanguageModelSessionSimulator implements SessionLike {
  readonly #fallback: string
  readonly #rules: ResponseRule[]

  constructor(rules: ResponseRule[], fallback: string) {
    this.#rules = rules
    this.#fallback = fallback
  }

  async prompt(messages: Message[]): Promise<string> {
    return this.#resolve(messages)
  }

  promptStreaming(messages: Message[]): AsyncIterable<string> {
    const response = this.#resolve(messages)
    return (async function* generate(): AsyncGenerator<string> {
      yield await response
    })()
  }

  #resolve(messages: Message[]): string {
    const text = messages.map(m => m.content).join('\n')
    for (const rule of this.#rules) {
      if (rule.when(text)) {
        return rule.response
      }
    }
    return this.#fallback
  }
}

export function installLanguageModelSimulator(
  target: typeof globalThis = globalThis,
  options?: LanguageModelSimulatorOptions | undefined,
): LanguageModelSimulator {
  const simulator = new LanguageModelSimulator(options)
  ;(target as { LanguageModel?: LanguageModelLike | undefined }).LanguageModel =
    simulator
  return simulator
}
