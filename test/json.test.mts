import { describe, expect, it } from 'vitest'

import {
  buildPrefixedMessages,
  isParseableJson,
  mergePrefill,
  normalizeKeys,
  parseJsonWithFallback,
  promptStructured,
  repairJson,
} from '../src/json.mts'
import type { Message, SessionLike } from '../src/types.mts'

const identitySchema = {
  parse(value: unknown): unknown {
    return value
  },
}

const requireNumericASchema = {
  parse(value: unknown): { a: number } {
    if (
      typeof value === 'object' &&
      value !== null &&
      'a' in value &&
      typeof (value as Record<string, unknown>)['a'] === 'number'
    ) {
      return value as { a: number }
    }
    throw new Error('expected { a: number }')
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

  it('repairs a missing array close before the object close', () => {
    // Observed live from Gemini Nano in CI: the reply closed the object
    // while the points array was still open.
    const raw = '{"summary":"s","points":["a","b"}'
    expect(JSON.parse(repairJson(raw))).toStrictEqual({
      points: ['a', 'b'],
      summary: 's',
    })
  })

  it('closes containers left open at end of input', () => {
    expect(JSON.parse(repairJson('{"a":[1,2'))).toStrictEqual({ a: [1, 2] })
  })

  it('ignores braces inside string values while balancing', () => {
    expect(JSON.parse(repairJson('{"a":"}","b":1}'))).toStrictEqual({
      a: '}',
      b: 1,
    })
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

  it('retries when the first reply is empty and succeeds on the next', async () => {
    let calls = 0
    const replies = ['', '{"a":1}']
    const session: SessionLike = {
      async prompt(messages: Message[]): Promise<string> {
        void messages
        const reply = replies[calls] ?? ''
        calls += 1
        return reply
      },
      promptStreaming(): AsyncIterable<string> {
        return (async function* generate(): AsyncGenerator<string> {
          yield ''
        })()
      },
    }
    const result = await promptStructured(session, 'go', {
      prefill: '',
      schema: identitySchema,
    })
    expect(calls).toBe(2)
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ a: 1 })
  })

  it('forwards responseConstraint to the session prompt when set', async () => {
    const constraint = { properties: { a: { type: 'number' } }, type: 'object' }
    let seen: unknown
    const session: SessionLike = {
      async prompt(
        messages: Message[],
        options?: { responseConstraint?: object | undefined } | undefined,
      ): Promise<string> {
        void messages
        seen = options?.responseConstraint
        return '{"a":1}'
      },
      promptStreaming(): AsyncIterable<string> {
        return (async function* generate(): AsyncGenerator<string> {
          yield ''
        })()
      },
    }
    const result = await promptStructured(session, 'go', {
      prefill: '',
      responseConstraint: constraint,
      schema: identitySchema,
    })
    expect(seen).toBe(constraint)
    expect(result.ok).toBe(true)
  })

  it('omits the prompt options bag when no responseConstraint is set', async () => {
    let argCount = -1
    const session: SessionLike = {
      async prompt(
        messages: Message[],
        options?: { responseConstraint?: object | undefined } | undefined,
      ): Promise<string> {
        void messages
        argCount = options === undefined ? 1 : 2
        return '{"a":1}'
      },
      promptStreaming(): AsyncIterable<string> {
        return (async function* generate(): AsyncGenerator<string> {
          yield ''
        })()
      },
    }
    await promptStructured(session, 'go', {
      prefill: '',
      schema: identitySchema,
    })
    expect(argCount).toBe(1)
  })

  it('gives up after exhausting retries and reports the last error', async () => {
    let calls = 0
    const session: SessionLike = {
      async prompt(messages: Message[]): Promise<string> {
        void messages
        calls += 1
        return 'not json at all'
      },
      promptStreaming(): AsyncIterable<string> {
        return (async function* generate(): AsyncGenerator<string> {
          yield ''
        })()
      },
    }
    const result = await promptStructured(session, 'go', {
      prefill: '',
      retries: 1,
      schema: requireNumericASchema,
    })
    expect(calls).toBe(2)
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})
