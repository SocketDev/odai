import { describe, expect, it } from 'vitest'

import {
  installLanguageModelSimulator,
  LanguageModelSimulator,
} from '../src/simulator.mts'
import { createGeminiNanoModel } from '../src/model.mts'
import { runEval } from '../src/bench/index.mts'
import { createBenchResponseRules } from '../src/bench/simulator.mts'

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

  it('runs the bench battery with scenario-specific responses', async () => {
    const simulator = new LanguageModelSimulator({
      fallback: '{"summary":"fallback"}',
      rules: createBenchResponseRules(),
    })
    ;(globalThis as { LanguageModel?: object | undefined }).LanguageModel =
      simulator
    const model = await createGeminiNanoModel()
    const report = await runEval({ model })
    expect(report.total).toBe(8)
    expect(report.score).toBe(1)
  })
})
