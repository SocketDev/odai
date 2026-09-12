import { describe, expect, it } from 'vitest'
import {
  assessIntentQuality,
  intentAcceptanceCriteria,
} from '../../src/bench/intent/quality.mts'
import type { IntentObservation } from '../../src/bench/intent/quality.mts'

const abstention: null = null

function observations(): IntentObservation[] {
  return Array.from({ length: 100 }, (_, index) => ({
    caseId: `held-out-request-${index}`,
    expectedActionId: index < 50 ? 'inspect-project' : abstention,
    actionId: index < 50 ? 'inspect-project' : abstention,
    baselineActionId: abstention,
    validOutput: true,
    totalDurationMs: 120,
  }))
}

describe('prospective intent quality criteria', () => {
  it('accepts a sufficiently large paired real-backend improvement', () => {
    const report = assessIntentQuality(observations(), 'real', 'operation')
    expect(report).toMatchObject({
      eligible: true,
      evidence: 'real-backend',
      accuracy: 1,
      baselineAccuracy: 0.5,
      accuracyGain: 0.5,
      actionAccuracy: 1,
      abstentionAccuracy: 1,
      wrongActions: 0,
      invalidOutputs: 0,
      p95DurationMs: 120,
    })
    expect(Object.isFrozen(intentAcceptanceCriteria)).toBe(true)
  })

  it('never accepts simulator scores as real model evidence', () => {
    expect(
      assessIntentQuality(observations(), 'simulator', 'operation'),
    ).toMatchObject({ eligible: false, evidence: 'harness-only' })
  })

  it('does not mistake warm timing or missing baseline for admission evidence', () => {
    const samples = observations().map(row => ({
      ...row,
      baselineActionId: undefined,
    }))
    const report = assessIntentQuality(samples, 'real', 'warm-scenario')
    expect(report.eligible).toBe(false)
    expect(report.baselineAccuracy).toBeUndefined()
    expect(report.accuracyGain).toBeUndefined()
    expect(report.reasons).toContain(
      'Paired deterministic baseline was not measured.',
    )
    expect(report.reasons).toContain(
      'Warm scenario timing excludes operation setup.',
    )
  })

  it('requires held-out volume and both action and abstention cases', () => {
    for (const samples of [
      [],
      observations().slice(0, 20),
      observations().map(row => ({
        ...row,
        expectedActionId: abstention,
        actionId: abstention,
      })),
    ]) {
      expect(assessIntentQuality(samples, 'real', 'operation').eligible).toBe(
        false,
      )
    }
  })

  it('rejects wrong actions even when aggregate accuracy is high', () => {
    const samples = observations()
    samples[99]!.actionId = 'repair-project'
    expect(assessIntentQuality(samples, 'real', 'operation')).toMatchObject({
      eligible: false,
      wrongActions: 1,
      accuracy: 0.99,
    })
  })

  it('does not reward invalid output as a safe abstention', () => {
    const samples = observations()
    samples[99]!.validOutput = false
    expect(assessIntentQuality(samples, 'real', 'operation')).toMatchObject({
      eligible: false,
      invalidOutputs: 1,
      abstentionAccuracy: 0.98,
    })
  })

  it('requires measured improvement over the paired deterministic baseline', () => {
    const samples = observations().map(row => ({
      ...row,
      baselineActionId: row.expectedActionId,
    }))
    expect(assessIntentQuality(samples, 'real', 'operation')).toMatchObject({
      eligible: false,
      accuracyGain: 0,
    })
  })

  it('uses nearest-rank p95 of total request durations', () => {
    const samples = observations()
    for (let index = 94; index < samples.length; index += 1) {
      samples[index]!.totalDurationMs = 5001
    }
    expect(assessIntentQuality(samples, 'real', 'operation')).toMatchObject({
      eligible: false,
      p95DurationMs: 5001,
    })
    samples[94]!.totalDurationMs = 5000
    expect(assessIntentQuality(samples, 'real', 'operation')).toMatchObject({
      eligible: true,
      p95DurationMs: 5000,
    })
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid measurement duration %s',
    duration => {
      const samples = observations()
      samples[0]!.totalDurationMs = duration
      expect(() => assessIntentQuality(samples, 'real', 'operation')).toThrow(
        TypeError,
      )
    },
  )

  it('rejects duplicate cases instead of inflating the sample count', () => {
    const samples = observations()
    samples[1]!.caseId = samples[0]!.caseId
    expect(() => assessIntentQuality(samples, 'real', 'operation')).toThrow(
      TypeError,
    )
  })
})
