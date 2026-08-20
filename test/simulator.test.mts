import { describe, expect, it, vi } from 'vitest'

import {
  installLanguageModelSimulator,
  LanguageModelSimulator,
} from '../src/simulator.mts'
import { createBuiltinModel } from '../src/model.mts'
import { runEval } from '../src/bench/index.mts'
import { createBenchResponseRules } from '../src/bench/simulator.mts'

import type { LanguageModelFactory } from '@socketsecurity/lib/ai/builtin'

// odai delegates built-in model resolution to socket-lib's `ai/builtin`, whose
// real resolver probes the runtime once and caches. Mock it to re-read the
// per-case `globalThis.LanguageModel` install on every call.
vi.mock(import('@socketsecurity/lib/ai/builtin'), () => ({
  getLanguageModel: (): LanguageModelFactory | undefined =>
    ((globalThis as { LanguageModel?: unknown | undefined }).LanguageModel as
      | LanguageModelFactory
      | undefined) ?? undefined,
}))

describe('LanguageModelSimulator', () => {
  it('installs a global LanguageModel and returns available', async () => {
    installLanguageModelSimulator({
      fallback: '{"ok":true}',
      rules: [],
      target: globalThis,
    })
    const model = await createBuiltinModel()
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
    const model = await createBuiltinModel()
    const report = await runEval({ model })
    expect(report.total).toBe(18)
    expect(report.score).toBe(1)
  })
})
