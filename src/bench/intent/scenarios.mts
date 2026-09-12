import { classifyIntent } from '../../tasks/classify-intent.mts'
import type { OdaiModel } from '../../model.mts'
import type { Scenario } from '../scenarios.mts'
import type { ResponseRule } from '../../simulator.mts'
import { intentCases } from './fixtures.mts'
import type { IntentCase } from './fixtures.mts'

export function createIntentResponseRules(): ResponseRule[] {
  return intentCases.map(fixture => ({
    __proto__: null,
    when: text => text.includes(JSON.stringify(fixture.input)),
    response: JSON.stringify({ actionId: fixture.expectedActionId }),
  }))
}

export function createIntentScenario(fixture: IntentCase): Scenario {
  const scenario = {
    __proto__: null,
    name: `intent-${fixture.split}-${fixture.id}`,
    async run(model: OdaiModel) {
      const result = await classifyIntent(model, fixture.input, { retries: 0 })
      const ok = result.ok && result.data?.actionId === fixture.expectedActionId
      return {
        __proto__: null,
        name: '',
        ok,
        score: ok ? 1 : 0,
        raw: '',
        intent: {
          caseId: fixture.id,
          split: fixture.split,
          expectedActionId: fixture.expectedActionId,
          actionId: result.data?.actionId,
          validOutput: result.ok,
        },
        assertion: ok
          ? `${fixture.kind}: matched the catalog oracle`
          : `${fixture.kind}: did not match the catalog oracle`,
      }
    },
  }
  return scenario
}

export const intentScenarios = intentCases.map(createIntentScenario)
