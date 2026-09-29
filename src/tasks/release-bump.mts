/**
 * @file Classify a package release and summarize its user-facing changes.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createReleaseBumpPrompt,
  RELEASE_BUMP_FEW_SHOT,
  RELEASE_BUMP_SYSTEM_PROMPT,
} from '../prompts/release-bump.mts'
import type {
  ReleaseBumpAdvice,
  ReleaseBumpInput,
} from '../prompts/release-bump.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { ReleaseBumpAdvice, ReleaseBumpInput }

const ReleaseBumpSchema = Type.Object(
  {
    level: Type.Union([Type.Literal('patch'), Type.Literal('minor')]),
    notes: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 }),
  },
  { additionalProperties: false },
)

const ReleaseBumpSchemaLike = {
  parse(value: unknown): Static<typeof ReleaseBumpSchema> {
    return Value.Parse(ReleaseBumpSchema, value)
  },
}

export async function classifyReleaseBump(
  model: OdaiModel,
  input: ReleaseBumpInput,
): Promise<TaskResult<ReleaseBumpAdvice>> {
  validateReleaseBumpInput(input)
  const result = await model.promptStructured<Static<typeof ReleaseBumpSchema>>(
    createReleaseBumpPrompt(input),
    {
      initialPrompts: [
        { content: RELEASE_BUMP_SYSTEM_PROMPT, role: 'system' },
        ...RELEASE_BUMP_FEW_SHOT,
      ],
      prefill: '{"level":"',
      schema: ReleaseBumpSchemaLike,
    },
  )
  if (!result.ok || !input.firstRelease || result.data === undefined) {
    return result
  }
  return {
    ...result,
    data: { ...result.data, level: 'minor' },
  }
}

export function validateReleaseBumpInput(input: ReleaseBumpInput): void {
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof input.firstRelease !== 'boolean' ||
    !Array.isArray(input.commits) ||
    input.commits.length > 500 ||
    !input.commits.every(
      commit =>
        typeof commit === 'string' &&
        commit.trim().length > 0 &&
        commit.length <= 5000,
    )
  ) {
    throw new TypeError('Release bump input must contain bounded commit text.')
  }
}
