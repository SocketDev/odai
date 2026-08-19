/**
 * @file Human-readable report for the llama.cpp server conformance runner.
 *   Names every unexpected failure and every stale allowlist entry, because
 *   those are the two things a reader has to act on.
 */

import type { Summary } from './types.mts'

/**
 * Format the run. Counts first, then the actionable lists: unexpected
 * failures, allowlist entries that now pass, and allowlist ids the run never
 * reported.
 */
export function formatSummary(summary: Summary): string {
  const { missing, totals } = summary
  const lines: string[] = [
    'llama.cpp server conformance vs odai shim',
    `  passed:          ${totals.pass}`,
    `  expected fails:  ${totals['expected-fail']}`,
    `  skipped:         ${totals.skip}`,
    `  UNEXPECTED:      ${totals['unexpected-fail']}`,
    `  now passing:     ${totals['now-passing']}`,
    `  allowlist ids not reported: ${missing.length}`,
  ]
  const unexpected = summary.classified.filter(
    entry => entry.bucket === 'unexpected-fail',
  )
  if (unexpected.length > 0) {
    lines.push('', 'Unexpected failures — a route or wire shape regressed:')
    for (let i = 0, { length } = unexpected; i < length; i += 1) {
      const entry = unexpected[i]!
      lines.push(`  - ${entry.case.id}`)
      if (entry.case.detail !== '') {
        lines.push(`      ${entry.case.detail}`)
      }
    }
    lines.push(
      '',
      '  Fix: implement the behavior, or add the id to the allowlist with a',
      '  reason naming what odai does not implement.',
    )
  }
  const nowPassing = summary.classified.filter(
    entry => entry.bucket === 'now-passing',
  )
  if (nowPassing.length > 0) {
    lines.push('', 'Allowlisted tests that now pass — drop these entries:')
    for (let i = 0, { length } = nowPassing; i < length; i += 1) {
      lines.push(`  - ${nowPassing[i]!.case.id}`)
    }
  }
  if (missing.length > 0) {
    lines.push('', 'Allowlist ids the run never reported — renamed upstream:')
    for (let i = 0, { length } = missing; i < length; i += 1) {
      lines.push(`  - ${missing[i]!}`)
    }
  }
  return lines.join('\n')
}
