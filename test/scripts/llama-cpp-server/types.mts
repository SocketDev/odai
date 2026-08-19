/**
 * @file Shared types for the llama.cpp server conformance runner. odai serves
 *   the same routes `llama-server` does, so llama.cpp's own pytest suite is
 *   the conformance corpus: it runs against odai's shim and every result is
 *   bucketed against an allowlist.
 */

/**
 * One upstream test case, keyed the way the allowlist spells it:
 * `unit/test_chat_completion.py::test_name[params]`.
 */
export interface TestCase {
  id: string
  /**
   * `pass` when pytest reported neither failure nor error; `fail` otherwise.
   * A skipped case is reported as `skip` and never classified.
   */
  outcome: 'fail' | 'pass' | 'skip'
  /**
   * The failure text pytest recorded, trimmed. Empty for a pass.
   */
  detail: string
}

/**
 * How one result compares to the allowlist. `expected-fail` is an allowed
 * failure, `unexpected-fail` is a regression, and `now-passing` is a stale
 * allowlist entry — both non-zero outcomes for the runner.
 */
export type Bucket =
  | 'expected-fail'
  | 'now-passing'
  | 'pass'
  | 'skip'
  | 'unexpected-fail'

export interface Classified {
  bucket: Bucket
  case: TestCase
}

export interface Summary {
  classified: Classified[]
  /**
   * Allowlist ids the run never reported at all. A renamed or deleted upstream
   * test leaves one behind, and it is drift, not a pass.
   */
  missing: string[]
  totals: Record<Bucket, number>
}

/**
 * One allowlist entry: the test id plus the reason it is allowed to fail.
 */
export interface AllowlistEntry {
  id: string
  reason: string
}
