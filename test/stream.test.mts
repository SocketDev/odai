import { describe, expect, it } from 'vitest'

import {
  isReadableStream,
  mergeChunks,
  readChunks,
  streamPrompt,
  tryExtractEarlyField,
} from '../src/stream.mts'
import type { Message, SessionLike } from '../src/types.mts'

function createSession(chunks: string[]): SessionLike {
  return {
    prompt(): Promise<string> {
      return Promise.resolve(chunks.join(''))
    },
    promptStreaming(): AsyncIterable<string> {
      return (async function* generate(): AsyncGenerator<string> {
        for (let i = 0, { length } = chunks; i < length; i += 1) {
          yield chunks[i]!
        }
      })()
    },
  }
}

describe('stream', () => {
  it('normalizes cumulative chunks', async () => {
    const session = createSession(['hello', 'hello world', 'hello world!'])
    const result = await streamPrompt(session, [
      { content: 'hi', role: 'user' },
    ])
    expect(result.raw).toBe('hello world!')
  })

  it('normalizes delta chunks', async () => {
    const session = createSession(['hello ', 'world', '!'])
    const result = await streamPrompt(session, [
      { content: 'hi', role: 'user' },
    ])
    expect(result.raw).toBe('hello world!')
  })

  it('falls back to prompt when streaming is unavailable', async () => {
    // Deliberately out of contract: `SessionLike` requires `promptStreaming`,
    // and this asserts the fallback for a runtime session that omits it anyway
    // (an older browser build, a hand-rolled backend).
    const session = {
      async prompt(messages: Message[]): Promise<string> {
        void messages
        return 'plain'
      },
    } as unknown as SessionLike
    const result = await streamPrompt(session, [
      { content: 'hi', role: 'user' },
    ])
    expect(result.raw).toBe('plain')
  })

  it('extracts early field', async () => {
    const session = createSession(['{"sentiment":"positive"}'])
    let captured: unknown
    await streamPrompt(session, [{ content: 'hi', role: 'user' }], {
      earlyFieldPatterns: { sentiment: /"sentiment":"(?<value>[^"]+)"/ },
      onEarlyField(field): void {
        captured = field.value
      },
    })
    expect(captured).toBe('positive')
  })

  it('returns an aborted result without prompting when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const session = createSession(['unused'])
    const result = await streamPrompt(
      session,
      [{ content: 'hi', role: 'user' }],
      { abortSignal: controller.signal },
    )
    expect(result.aborted).toBe(true)
    expect(result.raw).toBe('')
  })

  it('does not call onEarlyField when no pattern matches', async () => {
    const session = createSession(['{"other":"value"}'])
    let called = false
    await streamPrompt(session, [{ content: 'hi', role: 'user' }], {
      earlyFieldPatterns: { sentiment: /"sentiment":"(?<value>[^"]+)"/ },
      onEarlyField(): void {
        called = true
      },
    })
    expect(called).toBe(false)
  })

  it('reads a ReadableStream returned by promptStreaming', async () => {
    const session: SessionLike = {
      async prompt(): Promise<string> {
        return 'unused'
      },
      promptStreaming(): ReadableStream<string> {
        return new ReadableStream<string>({
          start(controller): void {
            controller.enqueue('hello ')
            controller.enqueue('world')
            controller.close()
          },
        })
      },
    }
    const result = await streamPrompt(session, [
      { content: 'hi', role: 'user' },
    ])
    expect(result.raw).toBe('hello world')
  })
})

describe('isReadableStream', () => {
  it('recognizes a real ReadableStream and rejects other values', () => {
    expect(isReadableStream(new ReadableStream())).toBe(true)
    expect(isReadableStream(undefined)).toBe(false)
    // A JSON-parsed null is a real runtime input the guard screens for.
    expect(isReadableStream(JSON.parse('null'))).toBe(false)
    expect(isReadableStream({})).toBe(false)
  })
})

describe('mergeChunks', () => {
  it('keeps the longest cumulative prefix', () => {
    expect(mergeChunks(['ab', 'abc', 'abcd'])).toBe('abcd')
  })

  it('concatenates non-prefix deltas', () => {
    expect(mergeChunks(['ab', 'cd', 'ef'])).toBe('abcdef')
  })
})

describe('readChunks', () => {
  it('drains an async iterable', async () => {
    const iterable = (async function* generate(): AsyncGenerator<string> {
      yield 'a'
      yield 'b'
    })()
    expect(await readChunks(iterable)).toEqual(['a', 'b'])
  })
})

describe('tryExtractEarlyField', () => {
  it('parses a JSON-valued capture group', () => {
    expect(tryExtractEarlyField('{"n":42}', { n: /"n":(?<n>\d+)/ })).toEqual({
      name: 'n',
      value: 42,
    })
  })

  it('falls back to the raw capture when it is not valid JSON', () => {
    expect(
      tryExtractEarlyField('{"s":"hi"}', { s: /"s":"(?<s>[^"]+)/ }),
    ).toEqual({
      name: 's',
      value: 'hi',
    })
  })

  it('returns undefined when nothing matches', () => {
    expect(
      tryExtractEarlyField('nope', { s: /"s":"(?<s>[^"]+)"/ }),
    ).toBeUndefined()
  })
})
