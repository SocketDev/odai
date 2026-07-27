import { describe, expect, it } from 'vitest'

import { createMockModel, createMockSession } from '../src/node.mts'
import type { Message } from '../src/types.mts'

describe('createMockModel', () => {
  it('returns the canned response from promptStructured through the JSON path', async () => {
    const model = createMockModel('{"summary":"canned"}')
    const result = await model.promptStructured<{ summary: string }>('go', {
      prefill: '{"summary":"',
      schema: {
        parse(value: unknown): { summary: string } {
          const record = value as { summary?: unknown | undefined }
          if (typeof record.summary !== 'string') {
            throw new TypeError('summary must be a string')
          }
          return { summary: record.summary }
        },
      },
    })
    expect(result.ok).toBe(true)
    expect(result.data?.summary).toBe('canned')
  })

  it('streams the canned response as the raw reply', async () => {
    const model = createMockModel('streamed reply')
    const result = await model.promptStreaming('ignored input', {})
    expect(result.raw).toBe('streamed reply')
  })

  it('exposes the underlying mock session', () => {
    const model = createMockModel('{"ok":true}')
    expect(typeof model.rawSession().prompt).toBe('function')
  })
})

describe('createMockSession', () => {
  it('returns the response regardless of the messages passed to prompt', async () => {
    const session = createMockSession({ response: 'fixed' })
    const messages: Message[] = [{ content: 'anything', role: 'user' }]
    expect(await session.prompt(messages)).toBe('fixed')
  })

  it('yields the response as a single streamed chunk', async () => {
    const session = createMockSession({ response: 'one-shot' })
    const chunks: string[] = []
    for await (const chunk of session.promptStreaming!([
      { content: 'x', role: 'user' },
    ]) as AsyncIterable<string>) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual(['one-shot'])
  })
})
