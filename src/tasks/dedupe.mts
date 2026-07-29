/**
 * @file Dependency-deduplication task. Uses a structured prompt to ask the model
 *   which package versions can be collapsed without breaking consumers.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createDedupePrompt,
  DEDUPE_FEW_SHOT,
  DEDUPE_PREFILL,
  DEDUPE_SYNONYM_MAP,
  DEDUPE_SYSTEM_PROMPT,
} from '../prompts/dedupe.mts'
import type { DedupeResult } from '../prompts/dedupe.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { DedupeResult }

const DedupeSuggestionSchema = Type.Object(
  {
    packages: Type.Array(Type.String()),
    recommendedVersion: Type.String(),
    reasoning: Type.String(),
  },
  { additionalProperties: false },
)

const DedupeResultSchema = Type.Object(
  {
    suggestions: Type.Array(DedupeSuggestionSchema),
  },
  { additionalProperties: false },
)

const DedupeResultSchemaLike = {
  parse(value: unknown): Static<typeof DedupeResultSchema> {
    return Value.Parse(DedupeResultSchema, value)
  },
}

export async function dedupeDependencies(
  model: OdaiModel,
  manifestText: string,
  lockfileText: string,
): Promise<TaskResult<DedupeResult>> {
  return model.promptStructured<Static<typeof DedupeResultSchema>>(
    createDedupePrompt(manifestText, lockfileText),
    {
      initialPrompts: [
        { content: DEDUPE_SYSTEM_PROMPT, role: 'system' },
        ...DEDUPE_FEW_SHOT,
      ],
      prefill: DEDUPE_PREFILL,
      schema: DedupeResultSchemaLike,
      synonymMap: DEDUPE_SYNONYM_MAP,
    },
  )
}
