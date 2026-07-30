import { describe, expect, it } from 'vitest'

import { majorityResult } from '../src/best-of-n.mts'
import type { TaskResult } from '../src/types.mts'

function ok(verdict: string, raw: string): TaskResult<{ verdict: string }> {
  return { data: { verdict }, ok: true, raw }
}

function fail(error: string, raw: string): TaskResult<{ verdict: string }> {
  return { error, ok: false, raw }
}

const key = (data: { verdict: string }): string => data.verdict

describe('majorityResult', () => {
  it('returns the most frequent verdict', () => {
    const results = [
      ok('safe', 'a'),
      ok('unsafe', 'b'),
      ok('safe', 'c'),
      ok('safe', 'd'),
    ]
    const winner = majorityResult(results, key)
    expect(winner.data?.verdict).toBe('safe')
  })

  it('breaks a tie toward the earliest-sampled verdict', () => {
    const results = [ok('unsafe', 'a'), ok('safe', 'b')]
    const winner = majorityResult(results, key)
    expect(winner.data?.verdict).toBe('unsafe')
    expect(winner.raw).toBe('a')
  })

  it('returns the last failure when no sample succeeds', () => {
    const results = [fail('first', 'a'), fail('last', 'b')]
    const loser = majorityResult(results, key)
    expect(loser.ok).toBe(false)
    expect(loser.error).toBe('last')
    expect(loser.raw).toBe('b')
  })

  it('returns a synthetic failure when empty', () => {
    const loser = majorityResult([], key)
    expect(loser.ok).toBe(false)
    expect(loser.error).toBe('no samples')
    expect(loser.raw).toBe('')
  })

  it('returns the single element unchanged', () => {
    const only = ok('abstain', 'solo')
    expect(majorityResult([only], key)).toBe(only)
  })

  it('ignores failed samples when tallying', () => {
    const results = [fail('boom', 'a'), ok('safe', 'b'), fail('boom', 'c')]
    const winner = majorityResult(results, key)
    expect(winner.data?.verdict).toBe('safe')
    expect(winner.raw).toBe('b')
  })
})
