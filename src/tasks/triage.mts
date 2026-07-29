/**
 * @file Alert-triage task. The model receives aggregate security findings and
 *   returns plain-language sentences plus the top concern.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createTriagePrompt,
  TRIAGE_FEW_SHOT,
  TRIAGE_PREFILL,
  TRIAGE_SYNONYM_MAP,
  TRIAGE_SYSTEM_PROMPT,
} from '../prompts/triage.mts'
import type { AlertTriage } from '../prompts/triage.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { AlertTriage }

const AlertTriageSchema = Type.Object(
  {
    sentences: Type.Array(Type.String()),
    topConcern: Type.String(),
  },
  { additionalProperties: false },
)

const AlertTriageSchemaLike = {
  parse(value: unknown): Static<typeof AlertTriageSchema> {
    return Value.Parse(AlertTriageSchema, value)
  },
}

export async function triageAlerts(
  model: OdaiModel,
  findingsText: string,
): Promise<TaskResult<AlertTriage>> {
  return model.promptStructured<Static<typeof AlertTriageSchema>>(
    createTriagePrompt(findingsText),
    {
      initialPrompts: [
        { content: TRIAGE_SYSTEM_PROMPT, role: 'system' },
        ...TRIAGE_FEW_SHOT,
      ],
      prefill: TRIAGE_PREFILL,
      schema: AlertTriageSchemaLike,
      synonymMap: TRIAGE_SYNONYM_MAP,
    },
  )
}
