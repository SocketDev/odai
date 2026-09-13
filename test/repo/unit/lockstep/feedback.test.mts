import { describe, expect, it } from 'vitest'

import { createLockstepExample } from '../../../../src/lockstep/examples.mts'
import {
  createLockstepCorrection,
  describeLockstepFailure,
} from '../../../../src/lockstep/feedback.mts'

describe('lockstep correction evidence', () => {
  it('retains the original input and bounds the previous model response', () => {
    const { input } = createLockstepExample('full')
    const raw = 'x'.repeat(40_000)
    const correction = JSON.parse(
      createLockstepCorrection(input, raw, 'observed mismatch'),
    )
    expect(correction.input).toEqual(input)
    expect(correction.previousResponse).toBe(raw.slice(0, 32_000))
    expect(correction.validationFeedback).toBe('observed mismatch')
  })

  it.each([
    'lockstep:invalid-analysis',
    'lockstep:invalid-change',
    'lockstep:invalid-citation',
    'lockstep:invalid-patch',
    'lockstep:missing-regression-test',
    'lockstep:missing-target-citation',
  ])('adds bounded host guidance to the contract error %s', code => {
    const feedback = describeLockstepFailure(code)
    expect(feedback.startsWith(code)).toBe(true)
    expect(feedback.length).toBeGreaterThan(code.length)
    expect(feedback.length).toBeLessThan(2500)
  })

  it('bounds unrecognized host diagnostics', () => {
    expect(describeLockstepFailure('x'.repeat(5000))).toHaveLength(2000)
  })
})
