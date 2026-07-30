/**
 * @file Weekly dependency-update plan task. Asks the model which outdated
 *   dependencies to bump this week, honoring the project's soak window and
 *   flagging major-crossing bumps.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createWeeklyUpdatePrompt,
  WEEKLY_UPDATE_FEW_SHOT,
  WEEKLY_UPDATE_PREFILL,
  WEEKLY_UPDATE_SYNONYM_MAP,
  WEEKLY_UPDATE_SYSTEM_PROMPT,
} from '../prompts/weekly-update.mts'
import type {
  WeeklyUpdateInput,
  WeeklyUpdatePlan,
} from '../prompts/weekly-update.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { WeeklyUpdateInput, WeeklyUpdatePlan }

const WeeklyUpdateEntrySchema = Type.Object(
  {
    from: Type.String(),
    name: Type.String(),
    reason: Type.String(),
    to: Type.String(),
  },
  { additionalProperties: false },
)

const WeeklyUpdatePlanSchema = Type.Object(
  {
    updates: Type.Array(WeeklyUpdateEntrySchema),
  },
  { additionalProperties: false },
)

const WeeklyUpdatePlanSchemaLike = {
  parse(value: unknown): Static<typeof WeeklyUpdatePlanSchema> {
    return Value.Parse(WeeklyUpdatePlanSchema, value)
  },
}

export async function planWeeklyUpdate(
  model: OdaiModel,
  input: WeeklyUpdateInput,
): Promise<TaskResult<WeeklyUpdatePlan>> {
  return model.promptStructured<Static<typeof WeeklyUpdatePlanSchema>>(
    createWeeklyUpdatePrompt(input),
    {
      initialPrompts: [
        { content: WEEKLY_UPDATE_SYSTEM_PROMPT, role: 'system' },
        ...WEEKLY_UPDATE_FEW_SHOT,
      ],
      prefill: WEEKLY_UPDATE_PREFILL,
      schema: WeeklyUpdatePlanSchemaLike,
      synonymMap: WEEKLY_UPDATE_SYNONYM_MAP,
    },
  )
}
