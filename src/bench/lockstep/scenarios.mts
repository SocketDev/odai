import { analyzeLockstep } from '../../tasks/lockstep.mts'
import {
  createLockstepEvaluation,
  createLockstepEvaluationProposal,
} from './fixtures.mts'
import type { Scenario } from '../scenarios.mts'
import type { ResponseRule } from '../../simulator.mts'

export function createLockstepResponseRules(): ResponseRule[] {
  return (['full', 'sparse'] as const).map(materialization => {
    const example = createLockstepEvaluation(materialization)
    return {
      __proto__: null,
      response: JSON.stringify(createLockstepEvaluationProposal(example)),
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
      const ok =
        result.ok &&
        result.data?.verdict === 'port' &&
        samePatches(result.data.patches, example.output.patches)
      return {
        __proto__: null,
        name: `lockstep-${materialization}-contract`,
        ok,
        score: ok ? 1 : 0,
        raw: result.raw,
        assertion: ok
          ? 'Citations, patch scope, and the expected fixture changes passed validation.'
          : (result.error ??
            result.data?.questions.join(', ') ??
            'The generated changes differ from the expected fixture changes.'),
      }
    },
  } as Scenario
}

export const lockstepScenarios: Scenario[] = [
  createLockstepScenario('full'),
  createLockstepScenario('sparse'),
]

export function samePatches(
  actual: Array<{ path: string; patch: string }>,
  expected: Array<{ path: string; patch: string }>,
): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (item, index) =>
        item.path === expected[index]?.path &&
        item.patch === expected[index]?.patch,
    )
  )
}
