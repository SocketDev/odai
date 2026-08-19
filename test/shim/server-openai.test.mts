import { afterEach, describe, expect, it } from 'vitest'

import { startShimServer } from '../../src/shim/server.mts'
import { createScriptedBackend } from './_shared/scripted-backend.mts'
import type { ShimServerHandle } from '../../src/shim/server.mts'

function parseDataFrames(text: string): string[] {
  const frames: string[] = []
  const blocks = text.split('\n\n')
  for (let i = 0, { length } = blocks; i < length; i += 1) {
    const match = blocks[i]!.match(/^data: (.+)$/m)
    if (match?.[1] !== undefined) {
      frames.push(match[1])
    }
  }
  return frames
}

describe('startShimServer OpenAI routes', () => {
  let handle: ShimServerHandle | undefined

  afterEach(async () => {
    await handle?.close()
    handle = undefined
  })

  it('lists one model and answers both health paths', async () => {
    handle = await startShimServer({ backend: createScriptedBackend([]) })
    // Exercising the shim's raw HTTP surface; the assertion is on the bare
    // Response body.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const models = await fetch(`${handle.url}/v1/models`)
    expect(models.status).toBe(200)
    const list = (await models.json()) as {
      data: Array<{ id: string; object: string; owned_by: string }>
      object: string
    }
    expect(list.object).toBe('list')
    expect(list.data).toHaveLength(1)
    expect(list.data[0]?.id).toBe('simulator')
    expect(list.data[0]?.owned_by).toBe('odai')

    // Exercising the shim's raw HTTP surface; the assertion is on the bare
    // Response status.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const aliased = await fetch(`${handle.url}/v1/health`)
    expect(aliased.status).toBe(200)
  })

  it('serves a non-streaming chat completion and defaults an absent model', async () => {
    const backend = createScriptedBackend(['plain answer'])
    handle = await startShimServer({ backend })
    // Exercising the shim's raw HTTP surface; the assertion is on the bare
    // Response body.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const response = await fetch(`${handle.url}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [
          { content: 'be terse', role: 'system' },
          { content: 'hi', role: 'user' },
        ],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(200)
    const completion = (await response.json()) as {
      choices: Array<{
        finish_reason: string
        message: { content: string; role: string }
      }>
      model: string
      object: string
      usage: { prompt_tokens: number; total_tokens: number }
    }
    expect(completion.object).toBe('chat.completion')
    // No model field arrived, so the shim answers with the backend it selected.
    expect(completion.model).toBe('simulator')
    expect(completion.choices[0]?.finish_reason).toBe('stop')
    expect(completion.choices[0]?.message.content).toBe('plain answer')
    expect(completion.usage.total_tokens).toBeGreaterThan(0)
    expect(backend.prompts[0]?.[0]).toEqual({
      content: 'be terse',
      role: 'system',
    })
  })

  it('drives a full streaming tool_calls round-trip', async () => {
    const backend = createScriptedBackend([
      '{"tool_call": {"name": "get_time", "input": {"zone": "UTC"}}}',
      'The time is 12:00 UTC.',
    ])
    handle = await startShimServer({ backend })
    const tools = [
      {
        function: {
          description: 'Get the current time.',
          name: 'get_time',
          parameters: {
            properties: { zone: { type: 'string' } },
            type: 'object',
          },
        },
        type: 'function',
      },
    ]

    // Exercising the shim's raw HTTP surface end to end, SSE text included.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const first = await fetch(`${handle.url}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: 'what time is it in UTC?', role: 'user' }],
        model: 'local-model',
        stream: true,
        stream_options: { include_usage: true },
        tools,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('text/event-stream')
    const frames = parseDataFrames(await first.text())
    expect(frames.at(-1)).toBe('[DONE]')
    const payloads = frames
      .slice(0, -1)
      .map(frame => JSON.parse(frame) as Record<string, unknown>)
    const opening = (
      payloads[1]!['choices'] as Array<{
        delta: { tool_calls: Array<{ function: { name: string }; id: string }> }
      }>
    )[0]!
    expect(opening.delta.tool_calls[0]?.function.name).toBe('get_time')
    const toolCallId = opening.delta.tool_calls[0]!.id
    expect(toolCallId).toMatch(/^call-/)
    const finishFrame = payloads.find(payload => {
      const choices = payload['choices'] as Array<{
        finish_reason: string | null
      }>
      return choices[0]?.finish_reason !== null
    })!
    expect(
      (finishFrame['choices'] as Array<{ finish_reason: string }>)[0]
        ?.finish_reason,
    ).toBe('tool_calls')
    expect(payloads.at(-1)!['usage']).toBeDefined()
    const systemMessage = backend.prompts[0]?.[0]
    expect(systemMessage?.content).toContain('# Tool protocol')

    // Exercising the shim's raw HTTP surface end to end, SSE text included.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const second = await fetch(`${handle.url}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [
          { content: 'what time is it in UTC?', role: 'user' },
          {
            content: '',
            role: 'assistant',
            tool_calls: [
              {
                function: { arguments: '{"zone":"UTC"}', name: 'get_time' },
                id: toolCallId,
                type: 'function',
              },
            ],
          },
          { content: '12:00', role: 'tool', tool_call_id: toolCallId },
        ],
        model: 'local-model',
        tools,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(second.status).toBe(200)
    const finished = (await second.json()) as {
      choices: Array<{ finish_reason: string; message: { content: string } }>
    }
    expect(finished.choices[0]?.finish_reason).toBe('stop')
    expect(finished.choices[0]?.message.content).toBe('The time is 12:00 UTC.')
    const replay = backend.prompts[1]!
    expect(replay.some(message => message.role === 'assistant')).toBe(true)
    expect(replay.at(-1)?.content).toContain(`[tool_result id=${toolCallId}]`)
    expect(replay.at(-1)?.content).toContain('12:00')
  })

  it('counts input tokens and answers errors in the OpenAI envelope', async () => {
    handle = await startShimServer({ backend: createScriptedBackend([]) })
    // Exercising the shim's raw HTTP surface; the assertion is on the bare
    // Response body.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const counted = await fetch(
      `${handle.url}/v1/chat/completions/input_tokens`,
      {
        body: JSON.stringify({
          messages: [{ content: 'x'.repeat(400), role: 'user' }],
          model: 'local-model',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
    )
    expect(counted.status).toBe(200)
    expect(await counted.json()).toEqual({
      input_tokens: 100,
      object: 'response.input_tokens',
    })

    // Exercising the shim's raw error path; the assertion is on the bare
    // error Response shape.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const bad = await fetch(`${handle.url}/v1/chat/completions`, {
      body: 'not json',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(bad.status).toBe(400)
    const badBody = (await bad.json()) as {
      error: { code: number; type: string }
    }
    expect(badBody.error.code).toBe(400)
    expect(badBody.error.type).toBe('invalid_request_error')

    // Exercising the shim's raw error path; the assertion is on the bare
    // error Response shape.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const empty = await fetch(`${handle.url}/v1/chat/completions`, {
      body: JSON.stringify({ messages: [], model: 'local-model' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(empty.status).toBe(400)

    // A JSON array body is valid JSON and still not a request object.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const array = await fetch(`${handle.url}/v1/messages`, {
      body: '[1,2]',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(array.status).toBe(400)
    const arrayBody = (await array.json()) as { type: string }
    expect(arrayBody.type).toBe('error')
  })
})
