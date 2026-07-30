import { describe, expect, it } from 'vitest'

import {
  buildPrefixedMessages,
  isParseableJson,
  mergePrefill,
  normalizeKeys,
  parseJsonWithFallback,
} from '../src/json.mts'

const identitySchema = {
  parse(value: unknown): unknown {
    return value
  },
}

describe('json', () => {
  it('builds prefixed messages with system prompt', () => {
    const messages = buildPrefixedMessages('hello', '{"a":', 'sys')
    expect(messages).toEqual([
      { content: 'sys', role: 'system' },
      { content: 'hello', role: 'user' },
      { content: '{"a":', role: 'assistant' },
    ])
  })

  it('merges prefill when missing', () => {
    expect(mergePrefill('{"a":', '1}')).toBe('{"a":1}')
  })

  it('does not duplicate prefill', () => {
    expect(mergePrefill('{"a":', '{"a":1}')).toBe('{"a":1}')
  })

  it('wraps an array-element continuation of a nested-array prefill', () => {
    // The model continued from `{"updates":[` without echoing it, so raw alone
    // is unbalanced (`{…}]}`) but prefill+raw parses.
    expect(mergePrefill('{"updates":[', '{"name":"x"}]}')).toBe(
      '{"updates":[{"name":"x"}]}',
    )
  })

  it('isParseableJson distinguishes valid from broken JSON', () => {
    expect(isParseableJson('{"a":1}')).toBe(true)
    expect(isParseableJson('{"a":1}]}')).toBe(false)
  })

  it('normalizes synonymous keys', () => {
    const result = normalizeKeys(
      { reason: 'x', tone: 'y', unknown: 'z' },
      { reason: ['rationale', 'explanation'], summary: ['tone'] },
    )
    expect(result).toEqual({ reason: 'x', summary: 'y', unknown: 'z' })
  })

  it('parses fenced json', () => {
    const data = parseJsonWithFallback(
      '```json\n{"a":1}\n```',
      identitySchema,
      undefined,
    )
    expect(data).toEqual({ a: 1 })
  })

  it('falls back to first object on parse failure', () => {
    const data = parseJsonWithFallback(
      'some text {"a":1} trailing',
      identitySchema,
      undefined,
    )
    expect(data).toEqual({ a: 1 })
  })

  it('recovers a double-escaped (string-encoded) object', () => {
    // Verbatim failure shape observed from real Gemini Nano: every structural
    // quote backslash-escaped, as if the object were JSON.stringify'd once more.
    const data = parseJsonWithFallback(
      '{\\"summary\\": \\"multiple versions\\"}',
      identitySchema,
      undefined,
    )
    expect(data).toEqual({ summary: 'multiple versions' })
  })

  it('repairs fullwidth punctuation and curly quotes', () => {
    // Verbatim failure shape observed from real Gemini Nano at temperature 0:
    // a fullwidth comma plus a curly opening quote mid-structure.
    const data = parseJsonWithFallback(
      '{"sentences":["There are 2 critical findings."]，“topConcern":"critical"}',
      identitySchema,
      undefined,
    )
    expect(data).toEqual({
      sentences: ['There are 2 critical findings.'],
      topConcern: 'critical',
    })
  })

  it('repairs fullwidth colons between key and value', () => {
    const data = parseJsonWithFallback(
      '{"a"：1，"b"：2}',
      identitySchema,
      undefined,
    )
    expect(data).toEqual({ a: 1, b: 2 })
  })

  it('still parses strict json containing curly quotes in values', () => {
    const data = parseJsonWithFallback(
      '{"quote":"a \u{201C}quoted\u{201D} word"}',
      identitySchema,
      undefined,
    )
    expect(data).toEqual({ quote: 'a \u{201C}quoted\u{201D} word' })
  })
})
