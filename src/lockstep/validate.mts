import { Value } from '@sinclair/typebox/value'

import { isLockstepPatch } from './patch.mts'
import {
  isLockstepArea,
  isLockstepPatchPath,
  isLockstepPath,
} from './paths.mts'
import { LockstepAnalysisSchema, LockstepInputSchema } from './schema.mts'
import type { LockstepAnalysis, LockstepInput } from './schema.mts'

export function abstainLockstep(reason: string): LockstepAnalysis {
  return { verdict: 'abstain', facts: [], patches: [], questions: [reason] }
}

export function hasLockstepImplementationAndTest(
  input: LockstepInput,
  analysis: LockstepAnalysis,
): boolean {
  return [input.row.localAreas, input.row.testAreas].every(areas =>
    analysis.patches.some(item => isLockstepArea(item.path, areas)),
  )
}

export function hasLockstepTargetCitations(
  input: LockstepInput,
  analysis: LockstepAnalysis,
): boolean {
  if (analysis.verdict === 'abstain') {
    return true
  }
  const targets = input.evidence.filter(
    item => item.side === 'upstream' && item.sha === input.row.targetSha,
  )
  const cited = new Set(analysis.facts.map(fact => fact.evidenceId))
  return (
    targets.length > 0 &&
    (analysis.verdict === 'no-change'
      ? targets.every(item => cited.has(item.id))
      : targets.some(item => cited.has(item.id)))
  )
}

export function lockstepVerdictError(
  input: LockstepInput,
  value: LockstepAnalysis,
): string | undefined {
  if (value.verdict !== 'port' && value.patches.length > 0) {
    return 'lockstep:unexpected-patch'
  }
  if (value.verdict !== 'abstain' && value.facts.length === 0) {
    return 'lockstep:missing-facts'
  }
  if (
    value.verdict === 'port' &&
    !hasLockstepImplementationAndTest(input, value)
  ) {
    return 'lockstep:missing-regression-test'
  }
  if (!hasLockstepTargetCitations(input, value)) {
    return 'lockstep:missing-target-citation'
  }
  if (value.verdict === 'abstain' && value.questions.length === 0) {
    return 'lockstep:missing-reason'
  }
  return undefined
}

export function parseLockstepInput(value: unknown): LockstepInput {
  // Check preserves the caller's exact authority. Parse would coerce or remove properties.
  if (!Value.Check(LockstepInputSchema, value)) {
    throw new Error('lockstep:invalid-input')
  }
  const { localAreas, testAreas, sparseCone, materialization } = value.row
  if (![...localAreas, ...testAreas, ...sparseCone].every(isLockstepPath)) {
    throw new Error('lockstep:invalid-area')
  }
  if ([...localAreas, ...testAreas].some(area => !isLockstepPatchPath(area))) {
    throw new Error('lockstep:protected-area')
  }
  if (
    localAreas.some(area => isLockstepArea(area, testAreas)) ||
    testAreas.some(area => isLockstepArea(area, localAreas))
  ) {
    throw new Error('lockstep:overlapping-areas')
  }
  if ((materialization === 'sparse') !== sparseCone.length > 0) {
    throw new Error('lockstep:invalid-materialization')
  }
  validateEvidence(value)
  return Value.Clone(value)
}

export function validateEvidence(input: LockstepInput): void {
  const ids = new Set<string>()
  let size = 0
  for (let i = 0, length = input.evidence.length; i < length; i += 1) {
    const item = input.evidence[i]!
    if (ids.has(item.id) || !isLockstepPath(item.path)) {
      throw new Error('lockstep:invalid-evidence')
    }
    ids.add(item.id)
    size += item.text.length
    if (item.side === 'upstream') {
      if (item.sha !== input.row.baseSha && item.sha !== input.row.targetSha) {
        throw new Error('lockstep:unanchored-evidence')
      }
      if (
        input.row.materialization === 'sparse' &&
        !isLockstepArea(item.path, input.row.sparseCone)
      ) {
        throw new Error('lockstep:outside-sparse-cone')
      }
    } else if (
      !isLockstepArea(
        item.path,
        item.side === 'local' ? input.row.localAreas : input.row.testAreas,
      )
    ) {
      throw new Error('lockstep:outside-evidence-area')
    }
  }
  if (size > 128_000) {
    throw new Error('lockstep:evidence-budget')
  }
}

export function validateLockstepAnalysis(
  input: LockstepInput,
  value: unknown,
): LockstepAnalysis {
  try {
    input = parseLockstepInput(input)
  } catch {
    return abstainLockstep('lockstep:invalid-input')
  }
  if (!Value.Check(LockstepAnalysisSchema, value)) {
    return abstainLockstep('lockstep:invalid-analysis')
  }
  if (
    input.truncated ||
    !input.evidence.some(item => item.side === 'upstream')
  ) {
    return abstainLockstep('lockstep:incomplete-evidence')
  }
  if (!validFacts(input, value)) {
    return abstainLockstep('lockstep:invalid-citation')
  }
  if (!validPatches(input, value)) {
    return abstainLockstep('lockstep:invalid-patch')
  }
  const verdictError = lockstepVerdictError(input, value)
  if (verdictError !== undefined) {
    return abstainLockstep(verdictError)
  }
  return Value.Clone(value)
}

export function validFacts(
  input: LockstepInput,
  analysis: LockstepAnalysis,
): boolean {
  return analysis.facts.every(fact => {
    const evidence = input.evidence.find(item => item.id === fact.evidenceId)
    if (!evidence || evidence.side !== 'upstream') {
      return false
    }
    const lineCount =
      evidence.text.split(/\r?\n/).length - Number(evidence.text.endsWith('\n'))
    return (
      fact.startLine >= evidence.startLine &&
      fact.endLine >= fact.startLine &&
      fact.endLine < evidence.startLine + lineCount
    )
  })
}

export function validPatches(
  input: LockstepInput,
  analysis: LockstepAnalysis,
): boolean {
  const paths = new Set<string>()
  const areas = [...input.row.localAreas, ...input.row.testAreas]
  return analysis.patches.every(item => {
    if (
      paths.has(item.path) ||
      !isLockstepPatchPath(item.path) ||
      !isLockstepArea(item.path, areas)
    ) {
      return false
    }
    paths.add(item.path)
    return isLockstepPatch(item.path, item.patch)
  })
}
