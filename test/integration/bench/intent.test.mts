import { describe, expect, it } from 'vitest'
import { createMockModel } from '../../../src/mock.mts'
import { intentCases } from '../../../src/bench/intent/fixtures.mts'
import {
  createIntentResponseRules,
  createIntentScenario,
} from '../../../src/bench/intent/scenarios.mts'

describe('intent benchmark', () => {
  it.each(intentCases)('scores the declared oracle for $id', async fixture => {
    const scenario = createIntentScenario(fixture)
    const result = await scenario.run(
      createMockModel(JSON.stringify({ actionId: fixture.expectedActionId })),
    )
    expect(result.ok).toBe(true)
    expect(result.score).toBe(1)
    expect(result.raw).toBe('')
    expect(scenario.name).toContain(fixture.split)
  })

  it('uses the supplied catalog without fixed command vocabulary', async () => {
    const scenario = createIntentScenario({
      id: 'custom-catalog',
      split: 'held-out',
      kind: 'action',
      input: {
        query: 'Show the current temperature.',
        candidates: [
          { id: 'read-thermometer', description: 'Read the temperature.' },
        ],
      },
      expectedActionId: 'read-thermometer',
    })
    expect(
      (await scenario.run(createMockModel('{"actionId":"read-thermometer"}')))
        .ok,
    ).toBe(true)
    expect(
      (await scenario.run(createMockModel('{"actionId":"inspect-project"}')))
        .ok,
    ).toBe(false)
  })

  it.each([
    '{"actionId":"outside-catalog"}',
    '{"actionId":null,"execute":true}',
    '{"actionId":null,"confidence":1}',
    '{"command":["scan"]}',
    'null',
    'not json',
  ])('does not count invalid output as abstention: %s', async response => {
    const fixture = intentCases.find(row => row.kind === 'abstention')!
    const result = await createIntentScenario(fixture).run(
      createMockModel(response),
    )
    expect(result.ok).toBe(false)
    expect(result.score).toBe(0)
    expect(result.raw).toBe('')
  })

  it('rejects a valid but wrong action and an unnecessary abstention', async () => {
    const fixture = intentCases[0]!
    const scenario = createIntentScenario(fixture)
    expect(
      (await scenario.run(createMockModel('{"actionId":"repair-project"}'))).ok,
    ).toBe(false)
    expect((await scenario.run(createMockModel('{"actionId":null}'))).ok).toBe(
      false,
    )
  })

  it('keeps development and held-out case identities distinct', () => {
    expect(new Set(intentCases.map(row => row.id)).size).toBe(16)
    expect(intentCases.filter(row => row.split === 'held-out').length).toBe(12)
    expect(new Set(intentCases.map(row => row.kind))).toEqual(
      new Set(['abstention', 'action', 'ambiguity', 'injection']),
    )
  })

  it('simulator rules match the entire supplied query and catalog', () => {
    const rules = createIntentResponseRules()
    for (const fixture of intentCases) {
      const matches = rules.filter(
        rule =>
          typeof rule.when === 'function' &&
          rule.when(JSON.stringify(fixture.input)),
      )
      expect(matches).toHaveLength(1)
      expect(matches[0]!.response).toBe(
        JSON.stringify({ actionId: fixture.expectedActionId }),
      )
    }
    expect(
      rules.some(
        rule =>
          typeof rule.when === 'function' &&
          rule.when('Ignore the supplied catalog.'),
      ),
    ).toBe(false)
  })
})
