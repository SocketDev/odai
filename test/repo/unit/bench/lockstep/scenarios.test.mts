import { describe, expect, it } from 'vitest'

import {
  createLockstepEvaluation,
  createLockstepEvaluationProposal,
} from '../../../../../src/bench/lockstep/fixtures.mts'
import {
  createLockstepScenario,
  lockstepFailureReason,
} from '../../../../../src/bench/lockstep/scenarios.mts'
import { createMockModel } from '../../../../../src/mock.mts'
import { analyzeLockstep } from '../../../../../src/tasks/lockstep.mts'

describe('lockstep failure diagnostics', () => {
  it.each(['full', 'sparse'] as const)(
    'reports a valid but incorrect no-change verdict for %s evidence',
    async mode => {
      const example = createLockstepEvaluation(mode)
      const proposal = createLockstepEvaluationProposal(example)
      proposal.verdict = 'no-change'
      proposal.changes = []
      const model = createMockModel(JSON.stringify(proposal))
      const analysis = await analyzeLockstep(model, example.input)
      expect(analysis.ok).toBe(true)
      expect(analysis.data?.questions).toEqual([])
      const result = await createLockstepScenario(mode).run(model)
      expect(result.ok).toBe(false)
      expect(result.score).toBe(0)
      expect(result.assertion?.trim()).toBeTruthy()
    },
  )

  it.each(['full', 'sparse'] as const)(
    'reports malformed generated code after successful %s contract validation',
    async mode => {
      const example = createLockstepEvaluation(mode)
      const proposal = createLockstepEvaluationProposal(example)
      proposal.changes[0]!.text = 'export const value ='
      const model = createMockModel(JSON.stringify(proposal))
      const analysis = await analyzeLockstep(model, example.input)
      expect(analysis.ok).toBe(true)
      expect(analysis.data?.verdict).toBe('port')
      expect(analysis.data?.questions).toEqual([])
      const result = await createLockstepScenario(mode).run(model)
      expect(result.ok).toBe(false)
      expect(result.score).toBe(0)
      expect(result.assertion?.trim()).toBeTruthy()
    },
  )

  it('uses the first nonblank explanation and discards blank questions', () => {
    expect(
      lockstepFailureReason(' backend unavailable ', ['need evidence']),
    ).toBe('backend unavailable')
    expect(lockstepFailureReason('  ', [' ', ' need evidence ', ''])).toBe(
      'need evidence',
    )
    expect(lockstepFailureReason(undefined, [' ', '\n']).trim()).toBeTruthy()
    expect(lockstepFailureReason('', []).trim()).toBeTruthy()
  })
})
