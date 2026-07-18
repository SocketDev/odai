import { describe, expect, it } from 'vitest'

import {
  installLanguageModelSimulator,
  LanguageModelSimulator,
} from '../src/simulator.mts'
import { createGeminiNanoModel } from '../src/model.mts'
import { runEval } from '../src/gnh/index.mts'
import { createGnhResponseRules } from '../src/gnh/simulator.mts'

describe('LanguageModelSimulator', () => {
  it('installs a global LanguageModel and returns available', async () => {
    installLanguageModelSimulator(globalThis, {
      fallback: '{"ok":true}',
      rules: [],
    })
    const model = await createGeminiNanoModel()
    const result = await model.promptStreaming('hello')
    expect(result.raw).toBe('{"ok":true}')
  })

  it('runs the gnh battery with scenario-specific responses', async () => {
    const simulator = new LanguageModelSimulator({
      fallback: '{"summary":"fallback"}',
      rules: createGnhResponseRules(),
    })
    ;(globalThis as { LanguageModel?: object | undefined }).LanguageModel =
      simulator
    const model = await createGeminiNanoModel()
    const report = await runEval({ model })
    expect(report.total).toBe(7)
    expect(report.score).toBe(1)
  })
})
