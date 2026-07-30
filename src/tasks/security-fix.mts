/**
 * @file Dependabot security-fix decision task. Asks the model to pick the safest
 *   minimal upgrade target for a vulnerable dependency, given the advisory, the
 *   affected range, and the versions available to upgrade to.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createSecurityFixPrompt,
  SECURITY_FIX_FEW_SHOT,
  SECURITY_FIX_PREFILL,
  SECURITY_FIX_SYNONYM_MAP,
  SECURITY_FIX_SYSTEM_PROMPT,
} from '../prompts/security-fix.mts'
import type {
  SecurityFixAssessment,
  SecurityFixInput,
} from '../prompts/security-fix.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { SecurityFixAssessment, SecurityFixInput }

const SecurityFixAssessmentSchema = Type.Object(
  {
    fixedVersion: Type.Optional(Type.String()),
    reason: Type.String(),
    verdict: Type.Union([
      Type.Literal('abstain'),
      Type.Literal('fixed'),
      Type.Literal('no-safe-version'),
    ]),
  },
  { additionalProperties: false },
)

const SecurityFixAssessmentSchemaLike = {
  parse(value: unknown): SecurityFixAssessment {
    const parsed: Static<typeof SecurityFixAssessmentSchema> = Value.Parse(
      SecurityFixAssessmentSchema,
      value,
    )
    return {
      fixedVersion: parsed.fixedVersion,
      reason: parsed.reason,
      verdict: parsed.verdict,
    }
  },
}

export async function assessSecurityFix(
  model: OdaiModel,
  input: SecurityFixInput,
): Promise<TaskResult<SecurityFixAssessment>> {
  return model.promptStructured<SecurityFixAssessment>(
    createSecurityFixPrompt(input),
    {
      initialPrompts: [
        { content: SECURITY_FIX_SYSTEM_PROMPT, role: 'system' },
        ...SECURITY_FIX_FEW_SHOT,
      ],
      prefill: SECURITY_FIX_PREFILL,
      schema: SecurityFixAssessmentSchemaLike,
      synonymMap: SECURITY_FIX_SYNONYM_MAP,
    },
  )
}
