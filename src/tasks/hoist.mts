/**
 * @file Cross-major hoist decision task. Asks the model whether hoisting a
 *   dependency across a major version is safe for this project, given the
 *   target changelog and the project's minimum supported Node.js major.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createHoistPrompt,
  HOIST_FEW_SHOT,
  HOIST_PREFILL,
  HOIST_SYNONYM_MAP,
  HOIST_SYSTEM_PROMPT,
} from '../prompts/hoist.mts'
import type { HoistAssessment, HoistInput } from '../prompts/hoist.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { HoistAssessment, HoistInput }

const HoistAssessmentSchema = Type.Object(
  {
    breakingChanges: Type.Array(Type.String()),
    reason: Type.String(),
    verdict: Type.Union([
      Type.Literal('abstain'),
      Type.Literal('safe'),
      Type.Literal('unsafe'),
    ]),
  },
  { additionalProperties: false },
)

const HoistAssessmentSchemaLike = {
  parse(value: unknown): Static<typeof HoistAssessmentSchema> {
    return Value.Parse(HoistAssessmentSchema, value)
  },
}

export async function assessHoistSafety(
  model: OdaiModel,
  input: HoistInput,
): Promise<TaskResult<HoistAssessment>> {
  return model.promptStructured<Static<typeof HoistAssessmentSchema>>(
    createHoistPrompt(input),
    {
      initialPrompts: [
        { content: HOIST_SYSTEM_PROMPT, role: 'system' },
        ...HOIST_FEW_SHOT,
      ],
      prefill: HOIST_PREFILL,
      schema: HoistAssessmentSchemaLike,
      synonymMap: HOIST_SYNONYM_MAP,
    },
  )
}
