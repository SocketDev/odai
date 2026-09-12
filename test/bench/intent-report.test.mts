import { expect, it } from 'vitest'
import { createMockModel } from '../../src/mock.mts'
import { formatReport, runEval } from '../../src/bench/index.mts'
import { createIntentScenario } from '../../src/bench/intent/scenarios.mts'
import { intentCases } from '../../src/bench/intent/fixtures.mts'

const abstention: null = null

it('reports simulator evidence and insufficient held-out samples in JSON and text', async () => {
  const fixture = intentCases.find(row => row.split === 'held-out')!
  const report = await runEval({
    model: createMockModel(
      JSON.stringify({ actionId: fixture.expectedActionId }),
    ),
    scenarios: [createIntentScenario(fixture)],
    evidence: 'simulator',
  })
  expect(report.intentQuality).toMatchObject({
    eligible: false,
    evidence: 'harness-only',
    total: 1,
  })
  expect(report.intentQuality?.reasons).toContain(
    'Insufficient held-out sample count: at least 100 required.',
  )
  expect(report.timing).toBe('warm-scenario')
  expect(JSON.parse(JSON.stringify(report))).toMatchObject({
    evidence: 'simulator',
  })
  expect(formatReport(report)).toContain(
    'intent default enablement: not eligible',
  )
  expect(formatReport(report)).toContain('No real-backend evidence.')
})

it('keeps development cases outside the held-out denominator', async () => {
  const fixture = intentCases.find(row => row.split === 'development')!
  const report = await runEval({
    model: createMockModel(
      JSON.stringify({ actionId: fixture.expectedActionId }),
    ),
    scenarios: [createIntentScenario(fixture)],
  })
  expect(report.evidence).toBe('unverified')
  expect(report.intentQuality).toBeUndefined()
})

it('reports a supplied paired baseline without claiming operation latency', async () => {
  const fixture = intentCases.find(row => row.split === 'held-out')!
  const report = await runEval({
    model: createMockModel(
      JSON.stringify({ actionId: fixture.expectedActionId }),
    ),
    scenarios: [createIntentScenario(fixture)],
    evidence: 'real',
    intentBaseline: new Map([[fixture.id, abstention]]),
  })
  expect(report.intentQuality?.accuracyGain).toBe(1)
  expect(report.intentQuality?.eligible).toBe(false)
  expect(report.intentQuality?.reasons).toContain(
    'Warm scenario timing excludes operation setup.',
  )
})
