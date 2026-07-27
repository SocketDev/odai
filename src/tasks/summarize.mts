/**
 * @file Text-summarization task. The model receives arbitrary text and
 *   returns a short summary plus the key points.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createSummarizePrompt,
  SUMMARIZE_FEW_SHOT,
  SUMMARIZE_PREFILL,
  SUMMARIZE_SYNONYM_MAP,
  SUMMARIZE_SYSTEM_PROMPT,
} from '../prompts/summarize.mts'
import type { TextSummary } from '../prompts/summarize.mts'
import type { GeminiNanoModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { TextSummary }

const TextSummarySchema = Type.Object(
  {
    points: Type.Array(Type.String()),
    summary: Type.String(),
  },
  { additionalProperties: false },
)

const TextSummarySchemaLike = {
  parse(value: unknown): Static<typeof TextSummarySchema> {
    return Value.Parse(TextSummarySchema, value)
  },
}

export async function summarizeText(
  model: GeminiNanoModel,
  text: string,
): Promise<TaskResult<TextSummary>> {
  return model.promptStructured<Static<typeof TextSummarySchema>>(
    createSummarizePrompt(text),
    {
      initialPrompts: [
        { content: SUMMARIZE_SYSTEM_PROMPT, role: 'system' },
        ...SUMMARIZE_FEW_SHOT,
      ],
      prefill: SUMMARIZE_PREFILL,
      schema: TextSummarySchemaLike,
      synonymMap: SUMMARIZE_SYNONYM_MAP,
    },
  )
}
