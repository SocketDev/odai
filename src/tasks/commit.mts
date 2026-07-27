/**
 * @file Commit-message task. The model receives a diff and returns a
 *   Conventional Commits subject line.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  COMMIT_FEW_SHOT,
  COMMIT_PREFILL,
  COMMIT_SYNONYM_MAP,
  COMMIT_SYSTEM_PROMPT,
  createCommitMessagePrompt,
} from '../prompts/commit.mts'
import type { CommitMessage } from '../prompts/commit.mts'
import type { GeminiNanoModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { CommitMessage }

const CommitMessageSchema = Type.Object(
  {
    subject: Type.String(),
  },
  { additionalProperties: false },
)

const CommitMessageSchemaLike = {
  parse(value: unknown): Static<typeof CommitMessageSchema> {
    return Value.Parse(CommitMessageSchema, value)
  },
}

export async function suggestCommitMessage(
  model: GeminiNanoModel,
  diff: string,
): Promise<TaskResult<CommitMessage>> {
  return model.promptStructured<Static<typeof CommitMessageSchema>>(
    createCommitMessagePrompt(diff),
    {
      initialPrompts: [
        { content: COMMIT_SYSTEM_PROMPT, role: 'system' },
        ...COMMIT_FEW_SHOT,
      ],
      prefill: COMMIT_PREFILL,
      schema: CommitMessageSchemaLike,
      synonymMap: COMMIT_SYNONYM_MAP,
    },
  )
}
