import { Value } from '@sinclair/typebox/value'

import { isLockstepArea, isLockstepPatchPath } from './paths.mts'
import { LockstepProposalSchema } from './schema.mts'
import type {
  LockstepAnalysis,
  LockstepInput,
  LockstepProposal,
} from './schema.mts'
import { validateLockstepAnalysis, validFacts } from './validate.mts'

export function buildChangedLines(before: string, after: string): string[] {
  const beforeLines = before.split(/\r?\n/)
  if (after.startsWith(`${before}\n`)) {
    return [
      ...beforeLines.map(line => ` ${line}`),
      ...after
        .slice(before.length + 1)
        .split(/\r?\n/)
        .map(line => `+${line}`),
    ]
  }
  return [
    ...beforeLines.map(line => `-${line}`),
    ...after.split(/\r?\n/).map(line => `+${line}`),
  ]
}

export function changePatch(
  input: LockstepInput,
  change: LockstepProposal['changes'][number],
): string | undefined {
  const evidence = input.evidence.find(
    item =>
      item.id === change.evidenceId &&
      item.path === change.path &&
      item.side !== 'upstream',
  )
  if (evidence === undefined || change.endLine < change.startLine) {
    return undefined
  }
  const lines = evidence.text.split(/\r?\n/)
  const first = change.startLine - evidence.startLine
  const last = change.endLine - evidence.startLine
  if (first < 0 || last >= lines.length) {
    return undefined
  }
  const before = lines.slice(first, last + 1).join('\n')
  const after =
    change.operation === 'append' ? `${before}\n${change.text}` : change.text
  return evidencePatch(change.path, before, after, change.startLine)
}

export function evidencePatch(
  path: string,
  before: string,
  after: string,
  start: number,
): string | undefined {
  if (!before || before.includes('\r') || after.includes('\r')) {
    return undefined
  }
  const oldCount = before.split(/\r?\n/).length
  const newCount = after.split(/\r?\n/).length
  const lines = buildChangedLines(before, after)
  return `--- a/${path}\n+++ b/${path}\n@@ -${rangeForPatch(start, oldCount)} +${rangeForPatch(start, newCount)} @@\n${lines.join('\n')}\n`
}

export function parseLockstepProposal(
  input: LockstepInput,
  value: unknown,
): LockstepAnalysis {
  if (!Value.Check(LockstepProposalSchema, value)) {
    throw new Error('lockstep:invalid-analysis')
  }
  if (!validFacts(input, { ...value, patches: [] })) {
    throw new Error('lockstep:invalid-citation')
  }
  const patches = proposalPatches(input, value)
  if (patches === undefined) {
    throw new Error('lockstep:invalid-change')
  }
  const analysis = validateLockstepAnalysis(input, {
    verdict: value.verdict,
    facts: value.facts,
    patches,
    questions: value.questions,
  })
  const reason = analysis.questions[0]
  if (analysis.verdict === 'abstain' && reason?.startsWith('lockstep:')) {
    throw new Error(reason)
  }
  return analysis
}

export function proposalPatches(
  input: LockstepInput,
  proposal: LockstepProposal,
): LockstepAnalysis['patches'] | undefined {
  const paths = new Set<string>()
  const areas = [...input.row.localAreas, ...input.row.testAreas]
  const patches: LockstepAnalysis['patches'] = []
  for (let i = 0, length = proposal.changes.length; i < length; i += 1) {
    const change = proposal.changes[i]!
    if (
      paths.has(change.path) ||
      !isLockstepPatchPath(change.path) ||
      !isLockstepArea(change.path, areas) ||
      change.text.includes('\0')
    ) {
      return undefined
    }
    paths.add(change.path)
    const patch = changePatch(input, change)
    if (patch === undefined) {
      return undefined
    }
    patches.push({ path: change.path, patch })
  }
  return patches
}

export function rangeForPatch(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`
}
