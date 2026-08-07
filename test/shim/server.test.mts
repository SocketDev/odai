import { Readable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import {
  parseMessagesRequest,
  readBody,
  ShimRequestError,
  startAnthropicShim,
} from '../../src/shim/server.mts'
import type { AnthropicShimHandle } from '../../src/shim/server.mts'
import type { IncomingMessage } from 'node:http'
import type { OdaiBackend } from '../../src/backends/types.mts'
import type { Message } from '../../src/types.mts'

interface SseEvent {
  data: Record<string, unknown>
  event: string
}

interface ScriptedBackend extends OdaiBackend {
  prompts: Message[][]
}

function createScriptedBackend(replies: string[]): ScriptedBackend {
  const prompts: Message[][] = []
  let call = 0
  return {
    async availability() {
      return { available: true }
    },
    async languageModel() {
      return {
        availability: async () => 'available',
        create: async () => ({
          prompt: async (messages: Message[]) => {
            prompts.push(messages)
            const reply = replies[call] ?? 'no scripted reply left'
            call += 1
            return reply
          },
          promptStreaming: () =>
            (async function* generate(): AsyncGenerator<string> {})(),
        }),
      }
    },
    name: 'simulator',
    prompts,
  }
}

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = []
  const blocks = text.split('\n\n')
  for (let i = 0, { length } = blocks; i < length; i += 1) {
    const block = blocks[i]!
    const eventMatch = block.match(/^event: (.+)$/m)
    const dataMatch = block.match(/^data: (.+)$/m)
    if (eventMatch?.[1] !== undefined && dataMatch?.[1] !== undefined) {
      events.push({
        data: JSON.parse(dataMatch[1]) as Record<string, unknown>,
        event: eventMatch[1],
      })
    }
  }
  return events
}

describe('startAnthropicShim', () => {
  let handle: AnthropicShimHandle | undefined

  afterEach(async () => {
    await handle?.close()
    handle = undefined
  })

  it('refuses to bind a non-loopback hostname', async () => {
    await expect(
      startAnthropicShim({
        backend: createScriptedBackend([]),
        hostname: '0.0.0.0',
      }),
    ).rejects.toThrow(/not loopback/)
  })

  it('serves a non-streaming text turn', async () => {
    const backend = createScriptedBackend(['plain answer'])
    handle = await startAnthropicShim({ backend })
    // Exercising the shim's raw HTTP surface end to end, SSE text and
    // Response status included.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const response = await fetch(`${handle.url}/v1/messages`, {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: 'hi', role: 'user' }],
        model: 'claude-sonnet-4-5',
        system: 'be terse',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(200)
    const message = (await response.json()) as {
      content: Array<{ text: string; type: string }>
      stop_reason: string
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(message.stop_reason).toBe('end_turn')
    expect(message.content).toEqual([{ text: 'plain answer', type: 'text' }])
    expect(message.usage.input_tokens).toBeGreaterThan(0)
    expect(backend.prompts[0]?.[0]).toEqual({
      content: 'be terse',
      role: 'system',
    })
  })

  it('drives a full streaming tool_use round-trip', async () => {
    const backend = createScriptedBackend([
      '{"tool_call": {"name": "get_time", "input": {"zone": "UTC"}}}',
      'The time is 12:00 UTC.',
    ])
    handle = await startAnthropicShim({ backend })
    const tools = [
      {
        description: 'Get the current time.',
        input_schema: {
          properties: { zone: { type: 'string' } },
          type: 'object',
        },
        name: 'get_time',
      },
    ]

    // Exercising the shim's raw HTTP surface end to end, SSE text and
    // Response status included.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const first = await fetch(`${handle.url}/v1/messages`, {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: 'what time is it in UTC?', role: 'user' }],
        model: 'claude-sonnet-4-5',
        stream: true,
        tools,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('text/event-stream')
    const events = parseSse(await first.text())
    expect(events.map(event => event.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    const blockStart = events[1]!.data as {
      content_block: { id: string; input: object; name: string; type: string }
    }
    expect(blockStart.content_block.type).toBe('tool_use')
    expect(blockStart.content_block.name).toBe('get_time')
    const toolUseId = blockStart.content_block.id
    expect(toolUseId).toMatch(/^toolu_/)
    const messageDelta = events[4]!.data as {
      delta: { stop_reason: string }
    }
    expect(messageDelta.delta.stop_reason).toBe('tool_use')
    const systemMessage = backend.prompts[0]?.[0]
    expect(systemMessage?.role).toBe('system')
    expect(systemMessage?.content).toContain('# Tool protocol')
    expect(systemMessage?.content).toContain('### get_time')

    // Exercising the shim's raw HTTP surface end to end, SSE text and
    // Response status included.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const second = await fetch(`${handle.url}/v1/messages`, {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          { content: 'what time is it in UTC?', role: 'user' },
          {
            content: [
              {
                id: toolUseId,
                input: { zone: 'UTC' },
                name: 'get_time',
                type: 'tool_use',
              },
            ],
            role: 'assistant',
          },
          {
            content: [
              {
                content: '12:00',
                tool_use_id: toolUseId,
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
        ],
        model: 'claude-sonnet-4-5',
        stream: true,
        tools,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(second.status).toBe(200)
    const secondEvents = parseSse(await second.text())
    const finalDelta = secondEvents.find(
      event => event.event === 'message_delta',
    )!.data as { delta: { stop_reason: string } }
    expect(finalDelta.delta.stop_reason).toBe('end_turn')
    const joined = secondEvents
      .filter(event => event.event === 'content_block_delta')
      .map(event => (event.data as { delta: { text: string } }).delta.text)
      .join('')
    expect(joined).toBe('The time is 12:00 UTC.')
    const replay = backend.prompts[1]!
    expect(replay.some(message => message.role === 'assistant')).toBe(true)
    const toolResultTurn = replay.at(-1)!
    expect(toolResultTurn.role).toBe('user')
    expect(toolResultTurn.content).toContain(`[tool_result id=${toolUseId}]`)
    expect(toolResultTurn.content).toContain('12:00')
  })

  it('estimates tokens on count_tokens and rejects bad bodies', async () => {
    const backend = createScriptedBackend([])
    handle = await startAnthropicShim({ backend })
    // Exercising the shim's raw HTTP surface end to end, SSE text and
    // Response status included.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const count = await fetch(`${handle.url}/v1/messages/count_tokens`, {
      body: JSON.stringify({
        messages: [{ content: 'x'.repeat(400), role: 'user' }],
        model: 'claude-sonnet-4-5',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(count.status).toBe(200)
    const counted = (await count.json()) as { input_tokens: number }
    expect(counted.input_tokens).toBe(100)

    // Exercising the shim's raw HTTP surface; the assertion is on the bare
    // error Response shape.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const bad = await fetch(`${handle.url}/v1/messages`, {
      body: 'not json',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(bad.status).toBe(400)
    const badBody = (await bad.json()) as {
      error: { type: string }
      type: string
    }
    expect(badBody.type).toBe('error')
    expect(badBody.error.type).toBe('invalid_request_error')

    // Exercising the shim's raw HTTP surface; the assertion is on the bare
    // Response status.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const missing = await fetch(`${handle.url}/v1/nope`, {
      body: '{}',
      method: 'POST',
    })
    expect(missing.status).toBe(404)

    // Exercising the shim's raw HTTP surface; the assertion is on the bare
    // Response status.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const health = await fetch(`${handle.url}/health`)
    expect(health.status).toBe(200)
  })

  it('404s a non-POST route that is not /health', async () => {
    handle = await startAnthropicShim({ backend: createScriptedBackend([]) })
    // Exercising the shim's bare HTTP route table; the assertion is on the
    // raw Response status.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const response = await fetch(`${handle.url}/v1/messages`)
    expect(response.status).toBe(404)
  })

  it('reports a 500 api_error when the backend prompt throws', async () => {
    const backend: OdaiBackend = {
      async availability() {
        return { available: true }
      },
      async languageModel() {
        return {
          availability: async () => 'available',
          create: async () => ({
            prompt: async () => {
              throw new Error('engine wedged')
            },
            promptStreaming: () =>
              (async function* generate(): AsyncGenerator<string> {})(),
          }),
        }
      },
      name: 'simulator',
    }
    handle = await startAnthropicShim({ backend })
    // Exercising the shim's raw error path; the assertion is on the bare
    // error Response shape.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const response = await fetch(`${handle.url}/v1/messages`, {
      body: JSON.stringify({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'm',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { type: string } }
    expect(body.error.type).toBe('api_error')
  })

  it('closes the backend when the handle closes', async () => {
    let closed = false
    const backend = {
      ...createScriptedBackend([]),
      async close(): Promise<void> {
        closed = true
      },
    }
    const local = await startAnthropicShim({ backend })
    await local.close()
    expect(closed).toBe(true)
  })
})

describe('parseMessagesRequest', () => {
  it('rejects a non-JSON body', () => {
    expect(() => parseMessagesRequest('not json')).toThrow(/not valid JSON/)
  })

  it('rejects an empty or missing messages array', () => {
    expect(() => parseMessagesRequest('{"model":"m","messages":[]}')).toThrow(
      /non-empty array/,
    )
    expect(() => parseMessagesRequest('{"model":"m"}')).toThrow(
      /non-empty array/,
    )
  })

  it('rejects a missing or empty model', () => {
    expect(() =>
      parseMessagesRequest('{"messages":[{"role":"user","content":"x"}]}'),
    ).toThrow(/model must be/)
    expect(() =>
      parseMessagesRequest(
        '{"model":"","messages":[{"role":"user","content":"x"}]}',
      ),
    ).toThrow(/model must be/)
  })

  it('accepts a well-formed request', () => {
    const parsed = parseMessagesRequest(
      '{"model":"m","messages":[{"role":"user","content":"hi"}]}',
    )
    expect(parsed.model).toBe('m')
  })
})

describe('readBody', () => {
  it('concatenates request chunks into a string', async () => {
    const request = Readable.from([
      Buffer.from('{"a":'),
      Buffer.from('1}'),
    ]) as unknown as IncomingMessage
    expect(await readBody(request)).toBe('{"a":1}')
  })

  it('rejects a body that exceeds the size limit', async () => {
    const oversized = Buffer.alloc(33 * 1024 * 1024)
    const request = Readable.from([oversized]) as unknown as IncomingMessage
    await expect(readBody(request)).rejects.toBeInstanceOf(ShimRequestError)
  })
})
