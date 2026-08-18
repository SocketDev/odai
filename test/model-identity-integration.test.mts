import { afterEach, describe, expect, it } from 'vitest'

import {
  installLanguageModelSimulator,
  LanguageModelSimulator,
} from '../src/simulator.mts'
import { createOdaiModel } from '../src/model.mts'
import type { Message } from '../src/types.mts'

/**
 * The stamp chain through the REAL simulator backend — no module mocks, so
 * CI (bare Node, no Chrome) proves the same code path production uses:
 * selectBackend -> session -> identity probe -> cached stamp on every
 * TaskResult. The simulator's rules make it accurate: it answers the
 * identity probe exactly like a named model would.
 */
describe('model identity through the simulator backend (CI-accurate)', () => {
  afterEach(() => {
    delete (globalThis as { LanguageModel?: unknown | undefined }).LanguageModel
    delete process.env['ODAI_BACKEND']
  })

  it('stamps the detected model identity the simulator reports', async () => {
    installLanguageModelSimulator({
      rules: [
        {
          response: 'Gemini Nano',
          when: (text: string) => text.includes('What model are you?'),
        },
        {
          response: '{"ok":true}',
          when: () => true,
        },
      ],
      target: globalThis,
    })
    const model = await createOdaiModel()
    const result = await model.promptStructured('{}', {
      prefill: '',
      retries: 0,
    })
    expect(result.model).toBe('Gemini Nano')
  })

  it('falls back to the backend registry name when the model names nothing known', async () => {
    const simulator = new LanguageModelSimulator({
      fallback: '{"ok":true}',
      rules: [
        {
          response: 'I am not a recognized family',
          when: (text: string) => text.includes('What model are you?'),
        },
      ],
    })
    ;(globalThis as { LanguageModel?: unknown | undefined }).LanguageModel =
      simulator
    process.env['ODAI_BACKEND'] = 'simulator'
    const model = await createOdaiModel()
    const result = await model.promptStructured('{}', {
      prefill: '',
      retries: 0,
    })
    expect(result.model).toBe('simulator')
  })
})
