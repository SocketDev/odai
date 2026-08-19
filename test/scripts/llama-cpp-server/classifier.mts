/**
 * @file Result bucketing for the llama.cpp server conformance runner. Pure: no
 *   I/O, no globals. This is the module that decides whether a run is green, so
 *   getting it wrong silently masks regressions — it is unit-tested
 *   exhaustively.
 */

import type {
  AllowlistEntry,
  Bucket,
  Classified,
  Summary,
  TestCase,
} from './types.mts'

/**
 * Bucket one case against the allowlist. A skip is never a verdict. A pass
 * that sits in the allowlist is `now-passing`: the entry is stale and has to
 * be dropped, which is drift to report rather than accept.
 */
export function classifyCase(
  testCase: TestCase,
  allowed: ReadonlySet<string>,
): Bucket {
  if (testCase.outcome === 'skip') {
    return 'skip'
  }
  if (testCase.outcome === 'pass') {
    return allowed.has(testCase.id) ? 'now-passing' : 'pass'
  }
  return allowed.has(testCase.id) ? 'expected-fail' : 'unexpected-fail'
}

/**
 * Classify a whole run: every reported case bucketed, plus the allowlist ids
 * the run never mentioned. A missing id means the upstream test carries a
 * different name now, so the entry allows nothing.
 */
export function classifyRun(
  cases: readonly TestCase[],
  allowlist: readonly AllowlistEntry[],
): Summary {
  const allowed = new Set(allowlist.map(entry => entry.id))
  const seen = new Set<string>()
  const classified: Classified[] = []
  const totals: Record<Bucket, number> = {
    'expected-fail': 0,
    'now-passing': 0,
    pass: 0,
    skip: 0,
    'unexpected-fail': 0,
  }
  for (let i = 0, { length } = cases; i < length; i += 1) {
    const testCase = cases[i]!
    seen.add(testCase.id)
    const bucket = classifyCase(testCase, allowed)
    totals[bucket] += 1
    classified.push({ bucket, case: testCase })
  }
  const missing = allowlist
    .map(entry => entry.id)
    .filter(id => !seen.has(id))
    .toSorted()
  return { classified, missing, totals }
}

/**
 * The runner's exit code: non-zero on an unexpected failure, a stale
 * allowlist entry, a missing allowlist id, or a run that reported nothing at
 * all. A suite that measured nothing is never a pass.
 */
export function exitCodeFor(summary: Summary): number {
  if (summary.classified.length === 0) {
    return 1
  }
  return summary.totals['unexpected-fail'] > 0 ||
    summary.totals['now-passing'] > 0 ||
    summary.missing.length > 0
    ? 1
    : 0
}
