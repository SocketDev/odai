import { describe, expect, it, vi } from 'vitest'

import {
  createLockstepEvaluation,
  createLockstepEvaluationProposal,
} from '../../../../../src/bench/lockstep/fixtures.mts'
import {
  createLockstepScenario,
  lockstepFailureReason,
  validateLockstepScenario,
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

it('repairs a syntax failure using the applied-code diagnostic and original evidence', async () => {
  const example = createLockstepEvaluation('full')
  const invalid = createLockstepEvaluationProposal(example)
  invalid.changes[0]!.text = 'export const value ='
  const valid = createLockstepEvaluationProposal(example)
  const model = createMockModel('')
  const prompt = vi
    .spyOn(model.rawSession(), 'prompt')
    .mockResolvedValueOnce(JSON.stringify(invalid))
    .mockResolvedValueOnce(JSON.stringify(valid))
  const result = await createLockstepScenario('full').run(model)
  expect(result.ok).toBe(true)
  expect(prompt).toHaveBeenCalledTimes(2)
  const messages = prompt.mock.calls[1]![0]
  const correction = JSON.parse(
    messages.findLast(item => item.role === 'user')!.content,
  )
  expect(correction.input).toEqual(example.input)
  expect(correction.validationFeedback).toBeTruthy()
  expect(JSON.parse(correction.previousResponse)).toEqual(invalid)
})

it('reports a patch that cannot apply to the supplied local evidence', () => {
  const example = createLockstepEvaluation('full')
  const local = example.input.evidence.find(item => item.side === 'local')!
  local.text = 'export const unrelated = 0\n'
  expect(
    validateLockstepScenario(example.input, example.output)?.trim(),
  ).toBeTruthy()
})

it('reports a patch without corresponding local evidence', () => {
  const example = createLockstepEvaluation('full')
  example.input.evidence = example.input.evidence.filter(
    item => item.side !== 'local',
  )
  expect(
    validateLockstepScenario(example.input, example.output)?.trim(),
  ).toBeTruthy()
})
