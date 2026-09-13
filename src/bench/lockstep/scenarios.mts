import { applyOraclePatch } from '../patch.mts'
import { isValidJavaScript } from '../verify-oracles.mts'
import type { LockstepAnalysis, LockstepInput } from '../../lockstep/schema.mts'
import { verifyLockstepEvaluation } from './verify.mts'
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
      const result = await analyzeLockstep(model, example.input, {
        validate: validateLockstepScenario,
      })
      const ok =
        result.ok &&
        result.data?.verdict === 'port' &&
        verifyLockstepEvaluation(example.input, result.data)
      return {
        __proto__: null,
        name: `lockstep-${materialization}-contract`,
        ok,
        score: ok ? 1 : 0,
        raw: result.raw,
        assertion: ok
          ? 'Citations, patch scope, and the expected fixture changes passed validation.'
          : lockstepFailureReason(result.error, result.data?.questions),
      }
    },
  } as Scenario
}

export function lockstepFailureReason(
  error: string | undefined,
  questions: string[] | undefined,
): string {
  return (
    error?.trim() ||
    questions
      ?.map(question => question.trim())
      .filter(Boolean)
      .join(', ') ||
    'The fixture requires valid code that exports 8 and an active regression test that asserts the imported value is 8.'
  )
}

export const lockstepScenarios: Scenario[] = [
  createLockstepScenario('full'),
  createLockstepScenario('sparse'),
]

export function validateLockstepScenario(
  input: LockstepInput,
  analysis: LockstepAnalysis,
): string | undefined {
  for (const patch of analysis.patches) {
    const evidence = input.evidence.find(
      item => item.path === patch.path && item.side !== 'upstream',
    )
    const code =
      evidence === undefined
        ? undefined
        : applyOraclePatch(evidence.text, patch.patch)
    if (code === undefined) {
      return `The patch for ${patch.path} did not apply to the supplied evidence. Use exact line ranges and retain surrounding lines.`
    }
    if (!isValidJavaScript(code)) {
      return `The applied file ${patch.path} is not valid JavaScript. Preserve its declarations, identifiers, delimiters, and complete statements when replacing lines.`
    }
  }
  return verifyLockstepEvaluation(input, analysis)
    ? undefined
    : 'The applied implementation or regression test does not match the target evidence. Compare local behavior with targetSha, not baseSha. Ensure an active test asserts target behavior using the imported local implementation.'
}
