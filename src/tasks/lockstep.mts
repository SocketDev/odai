import { LockstepAnalysisSchema } from '../lockstep/schema.mts'
import {
  abstainLockstep,
  parseLockstepInput,
  validateLockstepAnalysis,
} from '../lockstep/validate.mts'
import {
  createLockstepPrompt,
  LOCKSTEP_FEW_SHOT,
  LOCKSTEP_SYSTEM_PROMPT,
} from '../prompts/lockstep.mts'
import type { LockstepAnalysis, LockstepInput } from '../lockstep/schema.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { LockstepAnalysis, LockstepInput } from '../lockstep/schema.mts'

export async function analyzeLockstep(
  model: OdaiModel,
  input: LockstepInput,
): Promise<TaskResult<LockstepAnalysis>> {
  let parsed: LockstepInput
  try {
    parsed = parseLockstepInput(input)
  } catch (error) {
    return {
      ok: false,
      raw: '',
      error: error instanceof Error ? error.message : 'lockstep:invalid-input',
    }
  }
  if (
    parsed.truncated ||
    !parsed.evidence.some(item => item.side === 'upstream')
  ) {
    return {
      ok: true,
      raw: '',
      data: abstainLockstep('lockstep:incomplete-evidence'),
    }
  }
  const result = await model.promptStructured<LockstepAnalysis>(
    createLockstepPrompt(parsed),
    {
      prefill: '{',
      initialPrompts: [
        { role: 'system', content: LOCKSTEP_SYSTEM_PROMPT },
        ...LOCKSTEP_FEW_SHOT,
      ],
      responseConstraint: LockstepAnalysisSchema,
      schema: { parse: value => validateLockstepAnalysis(parsed, value) },
    },
  )
  if (!result.ok || result.data === undefined) {
    return result
  }
  return { ...result, data: validateLockstepAnalysis(parsed, result.data) }
}
