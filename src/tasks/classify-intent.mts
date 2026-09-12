import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

import { INTENT_SYSTEM_PROMPT } from '../prompts/classify-intent.mts'
import type {
  IntentCandidate,
  IntentInput,
  IntentResult,
} from '../prompts/classify-intent.mts'
import type { OdaiModel } from '../model.mts'
import type { PromptOptions, TaskResult } from '../types.mts'

export async function classifyIntent(
  model: OdaiModel,
  input: IntentInput,
  options: ClassifyIntentOptions = {},
): Promise<TaskResult<IntentResult>> {
  validateIntentInput(input)
  if (
    !Number.isInteger(options.retries ?? 0) ||
    (options.retries ?? 0) < 0 ||
    (options.retries ?? 0) > 2
  ) {
    throw new RangeError('Intent retries must be an integer between 0 and 2.')
  }
  options.abortSignal?.throwIfAborted()
  const schema = Type.Object(
    {
      actionId: Type.Union([
        ...input.candidates.map(candidate => Type.Literal(candidate.id)),
        Type.Null(),
      ]),
    },
    { additionalProperties: false },
  )
  return await model.promptStructured(JSON.stringify(input), {
    abortSignal: options.abortSignal,
    prefill: '',
    responseConstraint: schema,
    retries: options.retries ?? 0,
    schema: {
      parse(value: unknown): IntentResult {
        if (!Value.Check(schema, value)) {
          throw new TypeError(
            'Intent output must contain only an allowed actionId or null.',
          )
        }
        return value
      },
    },
    systemPrompt: INTENT_SYSTEM_PROMPT,
  })
}

export function validateIntentCandidate(candidate: IntentCandidate): void {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(candidate.id) ||
    typeof candidate.description !== 'string' ||
    candidate.description.trim() === '' ||
    candidate.description.length > 512
  ) {
    throw new TypeError(
      'Intent candidates require bounded IDs and descriptions.',
    )
  }
}

export interface ClassifyIntentOptions extends Pick<
  PromptOptions,
  'abortSignal'
> {
  retries?: number | undefined
}

export function validateIntentInput(input: IntentInput): void {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Intent input must be an object.')
  }
  if (
    typeof input.query !== 'string' ||
    input.query.trim() === '' ||
    input.query.length > 4096
  ) {
    throw new TypeError(
      'Intent query must contain between 1 and 4096 characters.',
    )
  }
  if (
    !Array.isArray(input.candidates) ||
    input.candidates.length === 0 ||
    input.candidates.length > 64
  ) {
    throw new TypeError(
      'Intent candidates must contain between 1 and 64 entries.',
    )
  }
  const ids = new Set<string>()
  for (const candidate of input.candidates) {
    validateIntentCandidate(candidate)
    if (ids.has(candidate.id)) {
      throw new TypeError('Intent candidates require unique IDs.')
    }
    ids.add(candidate.id)
  }
}
