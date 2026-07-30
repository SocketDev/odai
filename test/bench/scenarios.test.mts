import { describe, expect, it } from 'vitest'

import {
  alertSummaryScenario,
  askIntentScenario,
  codePatchScenario,
  codeRepairScenario,
  dedupeCandidateScenario,
  lockfileDuplicateScenario,
  safeAlternativeScenario,
  sbomAnomalyScenario,
  scoreTaskResult,
} from '../../src/bench/scenarios.mts'
import type { OdaiModel } from '../../src/model.mts'
import type { TaskResult } from '../../src/types.mts'

/**
 * A model that returns caller-chosen data as a passing structured result, so a
 * scenario's schema check succeeds and its behavioral assertion can be steered
 * to fail — exercising every "expected X" branch without a live backend.
 */
function fakeModel(data: unknown): OdaiModel {
  const result: TaskResult<unknown> = {
    ok: true,
    data,
    error: undefined,
    raw: JSON.stringify(data),
  }
  return {
    async promptStructured<T>(): Promise<TaskResult<T>> {
      return result as TaskResult<T>
    },
    async promptStreaming(): Promise<{ raw: string }> {
      return { raw: result.raw }
    },
    rawSession() {
      return { prompt: async () => result.raw }
    },
  }
}

describe('scoreTaskResult', () => {
  it('scores a failed task result as zero with its error', () => {
    const scored = scoreTaskResult(
      { ok: false, data: undefined, error: 'parse failed', raw: 'garbage' },
      () => ({ assertion: 'unused', ok: true }),
    )
    expect(scored.score).toBe(0)
    expect(scored.ok).toBe(false)
    expect(scored.assertion).toBe('parse failed')
  })

  it('falls back to a generic message when a failed result has no error', () => {
    const scored = scoreTaskResult(
      { ok: false, data: undefined, error: undefined, raw: '' },
      () => ({ assertion: 'unused', ok: true }),
    )
    expect(scored.assertion).toBe('task failed')
  })

  it('scores a passing assertion as one', () => {
    const scored = scoreTaskResult(
      { ok: true, data: 'x', error: undefined, raw: 'x' },
      () => ({ assertion: 'good', ok: true }),
    )
    expect(scored.score).toBe(1)
    expect(scored.ok).toBe(true)
  })
})

describe('scenario behavioral assertions on wrong answers', () => {
  it('fails alert-summary when no critical mention is present', async () => {
    const result = await alertSummaryScenario.run(
      fakeModel({ sentences: ['all quiet'], topConcern: 'low' }),
    )
    expect(result.ok).toBe(false)
    expect(result.assertion).toContain('expected summary to mention critical')
  })

  it('fails ask-intent when it does not route to fix', async () => {
    const result = await askIntentScenario.run(
      fakeModel({ command: ['audit'], confidence: 0.5, intent: 'audit' }),
    )
    expect(result.ok).toBe(false)
    expect(result.assertion).toContain('expected')
  })

  it('fails code-patch without a template literal', async () => {
    const result = await codePatchScenario.run(
      fakeModel({ explanation: 'x', patch: 'no template here' }),
    )
    expect(result.ok).toBe(false)
    expect(result.assertion).toContain('expected template-literal patch')
  })

  it('fails code-repair listing each unmet lint fix', async () => {
    const result = await codeRepairScenario.run(
      fakeModel({ explanation: 'x', fixed: 'import { deepEqual } from "x"' }),
    )
    expect(result.ok).toBe(false)
    expect(result.assertion).toContain('eqeqeq not fixed')
    expect(result.assertion).toContain('deepEqual import not removed')
    expect(result.assertion).toContain('join logic not preserved')
  })

  it('fails dedupe when chalk is not suggested', async () => {
    const result = await dedupeCandidateScenario.run(
      fakeModel({ suggestions: [{ packages: ['other'] }] }),
    )
    expect(result.ok).toBe(false)
    expect(result.assertion).toContain('expected chalk')
  })

  it('deterministically flags a lodash finding regardless of the model', async () => {
    const result = await lockfileDuplicateScenario.run(
      fakeModel({ findings: [{ package: 'react', reason: 'x' }] }),
    )
    expect(result.ok).toBe(true)
    expect(result.score).toBe(1)
    expect(result.assertion).toContain('found lodash-related finding')
  })

  it('fails safe-alternative when it is not lodash-es', async () => {
    const result = await safeAlternativeScenario.run(
      fakeModel({ alternative: 'moment', reasoning: 'x' }),
    )
    expect(result.ok).toBe(false)
    expect(result.assertion).toContain('expected lodash-es')
  })

  it('deterministically flags a duplicate-version anomaly regardless of the model', async () => {
    const result = await sbomAnomalyScenario.run(
      fakeModel({ anomalies: ['looks fine'], summary: 'x' }),
    )
    expect(result.ok).toBe(true)
    expect(result.score).toBe(1)
    expect(result.assertion).toContain('flagged duplicate component versions')
  })
})
