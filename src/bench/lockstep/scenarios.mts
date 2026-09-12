import { analyzeLockstep } from '../../tasks/lockstep.mts'
import { createLockstepEvaluation } from './fixtures.mts'
import type { Scenario } from '../scenarios.mts'
import type { ResponseRule } from '../../simulator.mts'

export function createLockstepResponseRules(): ResponseRule[] {
  return (['full', 'sparse'] as const).map(materialization => {
    const example = createLockstepEvaluation(materialization)
    return {
      __proto__: null,
      response: JSON.stringify(example.output),
      when: text => text.includes(example.input.row.id),
    }
  })
}

export function createLockstepScenario(
  materialization: 'full' | 'sparse',
): Scenario {
  const example = createLockstepEvaluation(materialization)
  return {
    __proto__: null,
    task: 'lockstep',
    name: `lockstep-${materialization}-contract`,
    async run(model) {
      const result = await analyzeLockstep(model, example.input)
      const ok = result.ok && result.data?.verdict === 'port'
      return {
        __proto__: null,
        name: `lockstep-${materialization}-contract`,
        ok,
        score: ok ? 1 : 0,
        raw: result.raw,
        assertion: ok
          ? 'Citations and patch scope passed validation. Behavior requires separate verification.'
          : (result.error ??
            result.data?.questions.join(', ') ??
            'No valid analysis'),
      }
    },
  } as Scenario
}

export const lockstepScenarios: Scenario[] = [
  createLockstepScenario('full'),
  createLockstepScenario('sparse'),
]
