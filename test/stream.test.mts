import { describe, expect, it } from 'vitest'

import { streamPrompt } from '../src/stream.mts'
import type { Message, SessionLike } from '../src/types.mts'

function createSession(chunks: string[]): SessionLike {
  return {
    prompt(): Promise<string> {
      return Promise.resolve(chunks.join(''))
    },
    promptStreaming(): AsyncIterable<string> {
      return (async function* generate(): AsyncGenerator<string> {
        for (let i = 0, { length } = chunks; i < length; i += 1) {
          const chunk = chunks[i]!
          yield chunk
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
    const session: SessionLike = {
      async prompt(messages: Message[]): Promise<string> {
        void messages
        return 'plain'
      },
    }
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
})
