/**
 * @file Lockfile-reasoning task. Wraps the Prompt API with a schema, few-shot
 *   examples, and synonym normalization so a small model returns usable JSON.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createLockfilePrompt,
  LOCKFILE_FEW_SHOT,
  LOCKFILE_PREFILL,
  LOCKFILE_SYNONYM_MAP,
  LOCKFILE_SYSTEM_PROMPT,
} from '../prompts/lockfile.mts'
import type { LockfileReasoning } from '../prompts/lockfile.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { LockfileReasoning }

const LockfileFindingSchema = Type.Object(
  {
    package: Type.String(),
    reason: Type.String(),
    severity: Type.Union([
      Type.Literal('high'),
      Type.Literal('medium'),
      Type.Literal('low'),
    ]),
  },
  { additionalProperties: false },
)

const LockfileReasoningSchema = Type.Object(
  {
    findings: Type.Array(LockfileFindingSchema),
    summary: Type.String(),
  },
  { additionalProperties: false },
)

const LockfileReasoningSchemaLike = {
  parse(value: unknown): Static<typeof LockfileReasoningSchema> {
    return Value.Parse(LockfileReasoningSchema, value)
  },
}

export async function reasonAboutLockfile(
  model: OdaiModel,
  lockfileText: string,
): Promise<TaskResult<LockfileReasoning>> {
  return model.promptStructured<Static<typeof LockfileReasoningSchema>>(
    createLockfilePrompt(lockfileText),
    {
      initialPrompts: [
        { content: LOCKFILE_SYSTEM_PROMPT, role: 'system' },
        ...LOCKFILE_FEW_SHOT,
      ],
      prefill: LOCKFILE_PREFILL,
      schema: LockfileReasoningSchemaLike,
      synonymMap: LOCKFILE_SYNONYM_MAP,
    },
  )
}
