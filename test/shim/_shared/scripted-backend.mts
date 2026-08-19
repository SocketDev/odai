/**
 * @file A backend whose replies are scripted, shared by the shim route tests.
 *   Each `prompt` call pops the next scripted reply and records the messages it
 *   was given, so a test can assert both what the shim answered and what it
 *   sent to the model.
 */

import type { OdaiBackend } from '../../../src/backends/types.mts'
import type { Message } from '../../../src/types.mts'

export interface ScriptedBackend extends OdaiBackend {
  prompts: Message[][]
}

export function createScriptedBackend(replies: string[]): ScriptedBackend {
  const prompts: Message[][] = []
  let call = 0
  return {
    async availability() {
      return { available: true }
    },
    async languageModel() {
      return {
        availability: async () => 'available',
        create: async () => ({
          prompt: async (messages: Message[]) => {
            prompts.push(messages)
            const reply = replies[call] ?? 'no scripted reply left'
            call += 1
            return reply
          },
          promptStreaming: () =>
            (async function* generate(): AsyncGenerator<string> {})(),
        }),
      }
    },
    name: 'simulator',
    prompts,
  }
}
