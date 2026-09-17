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
  const oldLines = terminatedPatchLines(before)
  const newLines = terminatedPatchLines(after)
  let first = 0
  while (first < oldLines.length && oldLines[first] === newLines[first]) {
    first += 1
  }
  let trailing = 0
  while (
    trailing < oldLines.length - first &&
    trailing < newLines.length - first &&
    oldLines[oldLines.length - trailing - 1] ===
      newLines[newLines.length - trailing - 1]
  ) {
    trailing += 1
  }
  return [
    ...oldLines.slice(0, first).flatMap(line => prefixedPatchLine(line, ' ')),
    ...oldLines
      .slice(first, oldLines.length - trailing)
      .flatMap(line => prefixedPatchLine(line, '-')),
    ...newLines
      .slice(first, newLines.length - trailing)
      .flatMap(line => prefixedPatchLine(line, '+')),
    ...oldLines
      .slice(oldLines.length - trailing)
      .flatMap(line => prefixedPatchLine(line, ' ')),
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
  if (
    evidence === undefined ||
    change.endLine < change.startLine ||
    evidence.text.includes('\r') ||
    change.text.includes('\r')
  ) {
    return undefined
  }
  const lines = proposalLines(evidence.text)
  const first = change.startLine - evidence.startLine
  const last = change.endLine - evidence.startLine
  if (first < 0 || last >= lines.length) {
    return undefined
  }
  const start = Math.max(0, first - 3)
  const end = Math.min(lines.length, last + 4)
  const ending = end < lines.length || evidence.text.endsWith('\n') ? '\n' : ''
  const before = lines.slice(start, end).join('\n') + ending
  const replacement = proposalLines(change.text)
  const afterLines = [
    ...lines.slice(start, change.operation === 'append' ? last + 1 : first),
    ...replacement,
    ...lines.slice(last + 1, end),
  ]
  const afterEnding =
    ending ||
    (last === lines.length - 1 && change.text.endsWith('\n') ? '\n' : '')
  return evidencePatch(
    change.path,
    before,
    afterLines.join('\n') + afterEnding,
    evidence.startLine + start,
  )
}

export function evidencePatch(
  path: string,
  before: string,
  after: string,
  start: number,
): string | undefined {
  if (
    !before ||
    before === after ||
    before.includes('\r') ||
    after.includes('\r')
  ) {
    return undefined
  }
  const oldCount = proposalLines(before).length
  const newCount = proposalLines(after).length
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

export function prefixedPatchLine(line: string, prefix: string): string[] {
  return line.endsWith('\n')
    ? [`${prefix}${line.slice(0, -1)}`]
    : [`${prefix}${line}`, '\\ No newline at end of file']
}

export function proposalLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (text.endsWith('\n')) {
    lines.pop()
  }
  return lines
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

export function terminatedPatchLines(text: string): string[] {
  const lines = proposalLines(text)
  return lines.map((line, index) =>
    index < lines.length - 1 || text.endsWith('\n') ? `${line}\n` : line,
  )
}
