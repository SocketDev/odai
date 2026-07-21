/**
 * @file Property/fuzz tests for src/stream.mts (Tier-1 fast-check). Streaming
 *   inference emits either CUMULATIVE snapshots (each chunk is the full text so
 *   far) or DELTA fragments (each chunk appends). mergeChunks must normalize
 *   both into the final text without ever throwing. tryExtractEarlyField and
 *   isReadableStream are pure predicates over untrusted values. Arbitraries are
 *   CONSTRUCTED so the merged outcome is known up front.
 */

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  isReadableStream,
  mergeChunks,
  tryExtractEarlyField,
} from '../src/stream.mts'

describe('stream/mergeChunks (fuzz)', () => {
  // Never-throws + monotonic-length invariant: the accumulator only grows (it
  // either replaces with a strictly-longer snapshot or appends a delta), so the
  // result is at least as long as the longest single chunk.
  test('never throws and is at least as long as the longest chunk', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), chunks => {
        let out = ''
        let threw = false
        try {
          out = mergeChunks(chunks)
        } catch {
          threw = true
        }
        expect(threw).toBe(false)
        expect(typeof out).toBe('string')
        const longest = chunks.reduce((max, c) => Math.max(max, c.length), 0)
        expect(out.length).toBeGreaterThanOrEqual(longest)
      }),
    )
  })

  // Restricted-input: the empty stream yields the empty string; a single chunk
  // is returned as-is.
  test('handles empty and singleton chunk lists', () => {
    expect(mergeChunks([])).toBe('')
    fc.assert(
      fc.property(fc.string(), only => {
        expect(mergeChunks([only])).toBe(only)
      }),
    )
  })

  // Oracle (cumulative): strictly-increasing prefixes of one base string are
  // recognized as snapshots, so the merge collapses to the last (longest) one.
  test('collapses cumulative prefix snapshots to the final snapshot', () => {
    const cumulativeArb = fc.string({ minLength: 1 }).chain(base =>
      fc
        .uniqueArray(fc.integer({ max: base.length, min: 1 }), {
          minLength: 1,
        })
        .map(lengths => {
          const cuts = [...lengths].toSorted((a, b) => a - b)
          return cuts.map(len => base.slice(0, len))
        }),
    )
    fc.assert(
      fc.property(cumulativeArb, chunks => {
        expect(mergeChunks(chunks)).toBe(chunks[chunks.length - 1])
      }),
    )
  })

  // Oracle (delta): when every chunk is a fresh fragment that can NOT be a
  // prefix-extension of what came before, the merge is plain concatenation.
  // Constructed by giving every fragment the SAME positive length: the first
  // chunk seeds the accumulator, and each equal-length successor fails the
  // `chunk.length > raw.length` snapshot test, so the append branch always
  // fires past the first chunk.
  test('concatenates equal-length delta fragments', () => {
    const equalLengthFragments = fc.integer({ max: 6, min: 1 }).chain(len =>
      fc.array(
        fc
          .array(fc.constantFrom(...'abcZ'), { maxLength: len, minLength: len })
          .map(chars => chars.join('')),
        { maxLength: 6, minLength: 1 },
      ),
    )
    fc.assert(
      fc.property(equalLengthFragments, fragments => {
        expect(mergeChunks(fragments)).toBe(fragments.join(''))
      }),
    )
  })
})

describe('stream/tryExtractEarlyField (fuzz)', () => {
  // Never-throws: a bad JSON capture must be swallowed (returned as the raw
  // string), never propagated.
  test('never throws for any raw input', () => {
    const patterns = { value: /"value":\s*(?<value>.+)/ }
    fc.assert(
      fc.property(fc.string(), raw => {
        let threw = false
        try {
          tryExtractEarlyField(raw, patterns)
        } catch {
          threw = true
        }
        expect(threw).toBe(false)
      }),
    )
  })

  // Oracle: a captured integer is JSON.parsed back to that number.
  test('parses a captured numeric field', () => {
    fc.assert(
      fc.property(fc.nat(), n => {
        const result = tryExtractEarlyField(`"count": ${n}`, {
          count: /"count":\s*(?<count>\d+)/,
        })
        expect(result).toEqual({ name: 'count', value: n })
      }),
    )
  })

  // Restricted-input: no patterns means nothing to extract.
  test('returns undefined when no pattern is supplied', () => {
    fc.assert(
      fc.property(fc.string(), raw => {
        expect(tryExtractEarlyField(raw, {})).toBeUndefined()
      }),
    )
  })
})

describe('stream/isReadableStream (fuzz)', () => {
  // Invariant: arbitrary non-stream values are never mistaken for a stream.
  test('is false for arbitrary non-stream values', () => {
    const nonStream = fc.oneof(
      // oxlint-disable-next-line socket/prefer-undefined-over-null -- null is a non-stream input under test
      fc.constant(null),
      fc.constant(undefined),
      fc.boolean(),
      fc.integer(),
      fc.string(),
      fc.array(fc.anything()),
      fc.dictionary(fc.string(), fc.anything()),
    )
    fc.assert(
      fc.property(nonStream, value => {
        expect(isReadableStream(value)).toBe(false)
      }),
    )
  })

  // Positive: any object exposing a getReader function is treated as a stream.
  test('is true for a getReader-bearing object', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), extra => {
        const streamLike = { ...extra, getReader: () => ({}) }
        expect(isReadableStream(streamLike)).toBe(true)
      }),
    )
  })
})
