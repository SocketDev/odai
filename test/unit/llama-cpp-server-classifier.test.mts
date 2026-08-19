import { describe, expect, it } from 'vitest'

import {
  loadAllowlist,
  parseAllowlist,
} from '../scripts/llama-cpp-server/allowlist.mts'
import {
  classifyCase,
  classifyRun,
  exitCodeFor,
} from '../scripts/llama-cpp-server/classifier.mts'
import type { TestCase } from '../scripts/llama-cpp-server/types.mts'

const ALLOWED = new Set(['unit/test_x.py::test_allowed'])

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    detail: '',
    id: 'unit/test_x.py::test_plain',
    outcome: 'pass',
    ...overrides,
  }
}

describe('classifyCase', () => {
  it('buckets every outcome-by-allowlist combination', () => {
    expect(classifyCase(testCase(), ALLOWED)).toBe('pass')
    expect(
      classifyCase(testCase({ id: 'unit/test_x.py::test_allowed' }), ALLOWED),
    ).toBe('now-passing')
    expect(classifyCase(testCase({ outcome: 'fail' }), ALLOWED)).toBe(
      'unexpected-fail',
    )
    expect(
      classifyCase(
        testCase({ id: 'unit/test_x.py::test_allowed', outcome: 'fail' }),
        ALLOWED,
      ),
    ).toBe('expected-fail')
  })

  it('never treats a skip as a verdict, allowlisted or not', () => {
    expect(classifyCase(testCase({ outcome: 'skip' }), ALLOWED)).toBe('skip')
    expect(
      classifyCase(
        testCase({ id: 'unit/test_x.py::test_allowed', outcome: 'skip' }),
        ALLOWED,
      ),
    ).toBe('skip')
  })
})

describe('classifyRun', () => {
  it('totals every bucket and reports unmatched allowlist ids', () => {
    const summary = classifyRun(
      [
        testCase(),
        testCase({ id: 'unit/test_x.py::test_allowed', outcome: 'fail' }),
        testCase({ id: 'unit/test_x.py::test_broken', outcome: 'fail' }),
        testCase({ id: 'unit/test_x.py::test_skipped', outcome: 'skip' }),
      ],
      [
        { id: 'unit/test_x.py::test_allowed', reason: 'allowed' },
        { id: 'unit/test_x.py::test_renamed', reason: 'stale' },
      ],
    )
    expect(summary.totals).toEqual({
      'expected-fail': 1,
      'now-passing': 0,
      pass: 1,
      skip: 1,
      'unexpected-fail': 1,
    })
    expect(summary.missing).toEqual(['unit/test_x.py::test_renamed'])
  })
})

describe('exitCodeFor', () => {
  it('passes only a run with no unexpected failure and no stale entry', () => {
    const clean = classifyRun(
      [
        testCase(),
        testCase({ id: 'unit/test_x.py::test_allowed', outcome: 'fail' }),
      ],
      [{ id: 'unit/test_x.py::test_allowed', reason: 'allowed' }],
    )
    expect(exitCodeFor(clean)).toBe(0)
  })

  it('fails on an unexpected failure', () => {
    const summary = classifyRun([testCase({ outcome: 'fail' })], [])
    expect(exitCodeFor(summary)).toBe(1)
  })

  it('fails on an allowlisted test that now passes', () => {
    const summary = classifyRun(
      [testCase({ id: 'unit/test_x.py::test_allowed' })],
      [{ id: 'unit/test_x.py::test_allowed', reason: 'allowed' }],
    )
    expect(exitCodeFor(summary)).toBe(1)
  })

  it('fails on an allowlist id the run never reported', () => {
    const summary = classifyRun(
      [testCase()],
      [{ id: 'unit/test_x.py::test_renamed', reason: 'stale' }],
    )
    expect(exitCodeFor(summary)).toBe(1)
  })

  it('fails a run that reported nothing at all', () => {
    expect(exitCodeFor(classifyRun([], []))).toBe(1)
  })
})

describe('parseAllowlist', () => {
  it('reads an entry with its reason and skips comments', () => {
    expect(
      parseAllowlist(
        [
          '# header',
          '',
          'unit/test_x.py::test_one  # because odai omits the field',
        ].join('\n'),
      ),
    ).toEqual([
      {
        id: 'unit/test_x.py::test_one',
        reason: 'because odai omits the field',
      },
    ])
  })

  it('refuses an entry with no reason', () => {
    expect(() => parseAllowlist('unit/test_x.py::test_one')).toThrow(
      /no reason/,
    )
  })

  it('refuses an entry with an empty id or reason', () => {
    expect(() => parseAllowlist('unit/test_x.py::test_one  #')).toThrow(
      /malformed/,
    )
  })

  it('treats a missing file as an empty allowlist', () => {
    expect(loadAllowlist('/path/to/example/absent.allowlist')).toEqual([])
  })
})
