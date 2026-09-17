import { awaitCancellable } from '../cancellation.mts'
import { createLockstepCorrection } from '../lockstep/feedback.mts'
import { parseLockstepProposal } from '../lockstep/proposal.mts'
import { LockstepProposalSchema } from '../lockstep/schema.mts'
import {
  abstainLockstep,
  parseLockstepInput,
  validateLockstepAnalysis,
} from '../lockstep/validate.mts'
import {
  createLockstepPrompt,
  LOCKSTEP_FEW_SHOT,
  LOCKSTEP_SYSTEM_PROMPT,
} from '../prompts/lockstep.mts'
import type { LockstepAnalysis, LockstepInput } from '../lockstep/schema.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { LockstepAnalysis, LockstepInput } from '../lockstep/schema.mts'

export interface LockstepOptions {
  abortSignal?: AbortSignal | undefined
  // Return a host diagnostic to reject a proposal. Validation must not execute generated code.
  validate?:
    | ((
        input: LockstepInput,
        analysis: LockstepAnalysis,
      ) => string | undefined | Promise<string | undefined>)
    | undefined
}

export async function analyzeLockstep(
  model: OdaiModel,
  input: LockstepInput,
  options: LockstepOptions = {},
): Promise<TaskResult<LockstepAnalysis>> {
  const opts = { __proto__: null, ...options }
  opts.abortSignal?.throwIfAborted()
  let parsed: LockstepInput
  try {
    parsed = parseLockstepInput(input)
  } catch (error) {
    return {
      ok: false,
      raw: '',
      error: error instanceof Error ? error.message : 'lockstep:invalid-input',
    }
  }
  if (
    parsed.truncated ||
    !parsed.evidence.some(
      item => item.side === 'upstream' && item.sha === parsed.row.targetSha,
    )
  ) {
    return {
      ok: true,
      raw: '',
      data: abstainLockstep('lockstep:incomplete-evidence'),
    }
  }
  let prompt = createLockstepPrompt(parsed)
  let result: TaskResult<LockstepAnalysis> = {
    ok: false,
    raw: '',
    error: 'lockstep:no-response',
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    opts.abortSignal?.throwIfAborted()
    result = await awaitCancellable(
      model.promptStructured<LockstepAnalysis>(prompt, {
        abortSignal: opts.abortSignal,
        prefill: '{',
        retries: 0,
        initialPrompts: [
          { role: 'system', content: LOCKSTEP_SYSTEM_PROMPT },
          ...LOCKSTEP_FEW_SHOT,
        ],
        responseConstraint: LockstepProposalSchema,
        schema: { parse: value => parseLockstepProposal(parsed, value) },
      }),
      opts.abortSignal,
    )
    opts.abortSignal?.throwIfAborted()
    result = await validateLockstepResult(parsed, result, opts)
    if (result.ok) {
      return result
    }
    prompt = createLockstepCorrection(
      parsed,
      result.raw,
      result.error ?? 'lockstep:invalid-analysis',
    )
  }
  return result
}

export async function validateLockstepResult(
  input: LockstepInput,
  result: TaskResult<LockstepAnalysis>,
  options: LockstepOptions,
): Promise<TaskResult<LockstepAnalysis>> {
  const opts = { __proto__: null, ...options }
  if (!result.ok) {
    return result
  }
  if (result.data === undefined) {
    return { ...result, ok: false, error: 'lockstep:invalid-analysis' }
  }
  const analysis = validateLockstepAnalysis(input, result.data)
  const contractError =
    analysis.verdict === 'abstain' &&
    analysis.questions[0]?.startsWith('lockstep:')
      ? analysis.questions[0]
      : undefined
  let error = contractError
  if (error === undefined && opts.validate !== undefined) {
    opts.abortSignal?.throwIfAborted()
    error = await awaitCancellable(
      Promise.resolve(opts.validate(input, analysis)),
      opts.abortSignal,
    )
    opts.abortSignal?.throwIfAborted()
    error = error?.trim() || undefined
  }
  return error === undefined
    ? { ...result, data: analysis }
    : { ...result, ok: false, error, data: abstainLockstep(error) }
}
