/**
 * @file Code-patching task. The model receives a file snippet and instruction,
 *   then returns a unified-diff-style patch plus an explanation.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createPatchPrompt,
  PATCH_FEW_SHOT,
  PATCH_PREFILL,
  PATCH_SYNONYM_MAP,
  PATCH_SYSTEM_PROMPT,
} from '../prompts/patch.mts'
import type { CodePatch } from '../prompts/patch.mts'
import type { GeminiNanoModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { CodePatch }

const CodePatchSchema = Type.Object(
  {
    explanation: Type.String(),
    patch: Type.String(),
  },
  { additionalProperties: false },
)

const CodePatchSchemaLike = {
  parse(value: unknown): Static<typeof CodePatchSchema> {
    return Value.Parse(CodePatchSchema, value)
  },
}

export async function generateCodePatch(
  model: GeminiNanoModel,
  fileContent: string,
  instruction: string,
): Promise<TaskResult<CodePatch>> {
  return model.promptStructured<Static<typeof CodePatchSchema>>(
    createPatchPrompt(fileContent, instruction),
    {
      initialPrompts: [
        { content: PATCH_SYSTEM_PROMPT, role: 'system' },
        ...PATCH_FEW_SHOT,
      ],
      prefill: PATCH_PREFILL,
      schema: CodePatchSchemaLike,
      synonymMap: PATCH_SYNONYM_MAP,
    },
  )
}
