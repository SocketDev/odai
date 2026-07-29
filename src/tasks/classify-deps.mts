/**
 * @file Dependency-change classification task. Wraps the Prompt API with a
 *   schema, few-shot examples, and synonym normalization so a small model
 *   returns a usable routine-vs-surprise verdict over a pre-narrowed diff.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  CLASSIFY_DEPS_FEW_SHOT,
  CLASSIFY_DEPS_PREFILL,
  CLASSIFY_DEPS_SYNONYM_MAP,
  CLASSIFY_DEPS_SYSTEM_PROMPT,
  createClassifyDepsPrompt,
} from '../prompts/classify-deps.mts'
import type { DepClassification } from '../prompts/classify-deps.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { DepClassification }

const DepClassificationSchema = Type.Object(
  {
    flags: Type.Array(Type.String()),
    note: Type.String(),
    surprise: Type.Boolean(),
  },
  { additionalProperties: false },
)

const DepClassificationSchemaLike = {
  parse(value: unknown): Static<typeof DepClassificationSchema> {
    return Value.Parse(DepClassificationSchema, value)
  },
}

export async function classifyDependencyChange(
  model: OdaiModel,
  narrowedDiffText: string,
): Promise<TaskResult<DepClassification>> {
  return model.promptStructured<Static<typeof DepClassificationSchema>>(
    createClassifyDepsPrompt(narrowedDiffText),
    {
      initialPrompts: [
        { content: CLASSIFY_DEPS_SYSTEM_PROMPT, role: 'system' },
        ...CLASSIFY_DEPS_FEW_SHOT,
      ],
      prefill: CLASSIFY_DEPS_PREFILL,
      schema: DepClassificationSchemaLike,
      synonymMap: CLASSIFY_DEPS_SYNONYM_MAP,
    },
  )
}
