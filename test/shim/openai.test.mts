import { describe, expect, it } from 'vitest'

import {
  buildChatCompletionChunks,
  flattenOpenAiContent,
  openAiToBackendMessages,
  parseArguments,
  replyToChatCompletion,
  toModelList,
  toProtocolTools,
  toStopSequences,
} from '../../src/shim/openai.mts'
import type { OpenAiChatRequest } from '../../src/shim/openai.mts'

const CREATED_AT = 1_760_000_000

const FINGERPRINT = 'odai-simulator'

const TOOLS = [
  {
    function: {
      description: 'Get the current time.',
      name: 'get_time',
      parameters: { properties: { zone: { type: 'string' } }, type: 'object' },
    },
    type: 'function' as const,
  },
]

function baseRequest(
  overrides: Partial<OpenAiChatRequest> = {},
): OpenAiChatRequest {
  return {
    messages: [{ content: 'hello', role: 'user' }],
    model: 'local-model',
    ...overrides,
  }
}

describe('flattenOpenAiContent', () => {
  it('passes a plain string through', () => {
    expect(flattenOpenAiContent('plain')).toBe('plain')
  })

  it('joins text parts and names dropped media', () => {
    expect(
      flattenOpenAiContent([
        { text: 'look', type: 'text' },
        {
          image_url: { url: 'https://example.com/cat.png' },
          type: 'image_url',
        },
        { input_audio: { data: 'AAA' }, type: 'input_audio' },
        { type: 'refusal' },
      ]),
    ).toBe('look\n[image omitted]\n[audio omitted]')
  })

  it('returns empty string for a non-array, non-string value', () => {
    expect(flattenOpenAiContent(42)).toBe('')
  })
})

describe('toProtocolTools', () => {
  it('narrows a function tool to the protocol shape', () => {
    expect(toProtocolTools(TOOLS)).toEqual([
      {
        description: 'Get the current time.',
        input_schema: {
          properties: { zone: { type: 'string' } },
          type: 'object',
        },
        name: 'get_time',
      },
    ])
  })

  it('omits absent description and parameters', () => {
    expect(
      toProtocolTools([{ function: { name: 'Bash' }, type: 'function' }]),
    ).toEqual([{ name: 'Bash' }])
  })

  it('drops a tool with no function spec', () => {
    const malformed = [{ type: 'function' }] as unknown as typeof TOOLS
    expect(toProtocolTools(malformed)).toEqual([])
  })
})

describe('parseArguments', () => {
  it('parses a JSON object', () => {
    expect(parseArguments('{"zone":"UTC"}')).toEqual({ zone: 'UTC' })
  })

  it('falls back to an empty object for unparseable or non-object text', () => {
    expect(parseArguments('not json')).toEqual({})
    expect(parseArguments('[1,2]')).toEqual({})
    expect(parseArguments('null')).toEqual({})
  })
})

describe('toStopSequences', () => {
  it('normalizes the three accepted shapes', () => {
    expect(toStopSequences(undefined)).toEqual([])
    expect(toStopSequences('END')).toEqual(['END'])
    expect(toStopSequences(['A', 'B'])).toEqual(['A', 'B'])
  })
})

describe('openAiToBackendMessages', () => {
  it('folds system and developer turns plus the tool protocol into one system message', () => {
    const messages = openAiToBackendMessages(
      baseRequest({
        messages: [
          { content: 'be terse', role: 'system' },
          { content: 'prefer UTC', role: 'developer' },
          { content: 'what time is it?', role: 'user' },
        ],
        tools: TOOLS,
      }),
    )
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('be terse')
    expect(messages[0]?.content).toContain('prefer UTC')
    expect(messages[0]?.content).toContain('# Tool protocol')
    expect(messages[0]?.content).toContain('### get_time')
    expect(messages[1]).toEqual({
      content: 'what time is it?',
      role: 'user',
    })
  })

  it('emits no system message when neither system turn nor tools exist', () => {
    const messages = openAiToBackendMessages(baseRequest())
    expect(messages).toEqual([{ content: 'hello', role: 'user' }])
  })

  it('replays assistant tool_calls as the canonical protocol line', () => {
    const messages = openAiToBackendMessages(
      baseRequest({
        messages: [
          { content: 'what time is it?', role: 'user' },
          {
            content: 'checking',
            role: 'assistant',
            tool_calls: [
              {
                function: { arguments: '{"zone":"UTC"}', name: 'get_time' },
                id: 'call-1',
                type: 'function',
              },
            ],
          },
          { content: '12:00', role: 'tool', tool_call_id: 'call-1' },
        ],
        tools: TOOLS,
      }),
    )
    const assistant = messages.find(message => message.role === 'assistant')
    expect(assistant?.content).toBe(
      'checking\n{"tool_call":{"input":{"zone":"UTC"},"name":"get_time"}}',
    )
    expect(messages.at(-1)).toEqual({
      content: '[tool_result id=call-1]\n12:00',
      role: 'user',
    })
  })

  it('tags a tool turn with no tool_call_id as unknown', () => {
    const messages = openAiToBackendMessages(
      baseRequest({ messages: [{ content: 'done', role: 'tool' }] }),
    )
    expect(messages[0]?.content).toBe('[tool_result id=unknown]\ndone')
  })

  it('skips an empty system turn', () => {
    const messages = openAiToBackendMessages(
      baseRequest({
        messages: [
          { content: '', role: 'system' },
          { content: 'hi', role: 'user' },
        ],
      }),
    )
    expect(messages).toEqual([{ content: 'hi', role: 'user' }])
  })
})

describe('replyToChatCompletion', () => {
  it('produces a text choice that finishes with stop', () => {
    const completion = replyToChatCompletion('plain answer', baseRequest(), {
      createdAt: CREATED_AT,
      fingerprint: FINGERPRINT,
      promptTokens: 10,
    })
    expect(completion.object).toBe('chat.completion')
    expect(completion.id).toMatch(/^chatcmpl-/)
    expect(completion.created).toBe(CREATED_AT)
    expect(completion.choices[0]?.finish_reason).toBe('stop')
    expect(completion.choices[0]?.message.content).toBe('plain answer')
    expect(completion.usage).toEqual({
      completion_tokens: 3,
      prompt_tokens: 10,
      total_tokens: 13,
    })
  })

  it('truncates at a stop sequence', () => {
    const completion = replyToChatCompletion(
      'keep this STOP drop that',
      baseRequest({ stop: 'STOP' }),
      {
        createdAt: CREATED_AT,
        fingerprint: FINGERPRINT,
        promptTokens: 4,
      },
    )
    expect(completion.choices[0]?.message.content).toBe('keep this ')
    expect(completion.choices[0]?.finish_reason).toBe('stop')
  })

  it('produces a tool_calls choice with null content', () => {
    const completion = replyToChatCompletion(
      '{"tool_call": {"name": "get_time", "input": {"zone": "UTC"}}}',
      baseRequest({ tools: TOOLS }),
      {
        createdAt: CREATED_AT,
        fingerprint: FINGERPRINT,
        promptTokens: 4,
      },
    )
    const choice = completion.choices[0]!
    expect(choice.finish_reason).toBe('tool_calls')
    // The wire format spells "no text" as an explicit null.
    expect(choice.message.content).toBe(JSON.parse('null'))
    const call = choice.message.tool_calls?.[0]
    expect(call?.id).toMatch(/^call-/)
    expect(call?.function.name).toBe('get_time')
    expect(JSON.parse(call!.function.arguments)).toEqual({ zone: 'UTC' })
  })
})

describe('buildChatCompletionChunks', () => {
  it('frames a text reply as role, content deltas, and a finish frame', () => {
    const completion = replyToChatCompletion('x'.repeat(200), baseRequest(), {
      createdAt: CREATED_AT,
      fingerprint: FINGERPRINT,
      promptTokens: 4,
    })
    const frames = buildChatCompletionChunks(completion, {
      includeUsage: false,
    })
    expect(frames).toHaveLength(4)
    expect(
      frames.every(frame => frame['object'] === 'chat.completion.chunk'),
    ).toBe(true)
    const deltas = frames.map(
      frame =>
        (frame['choices'] as Array<{ delta: Record<string, unknown> }>)[0]
          ?.delta,
    )
    // The opening frame is role plus an explicit null content, the shape
    // llama-server sends.
    expect(deltas[0]).toEqual({
      content: JSON.parse('null'),
      role: 'assistant',
    })
    const streamed = deltas.slice(1, 3).map(delta => delta?.['content'])
    expect(streamed.join('')).toBe('x'.repeat(200))
    const last = frames.at(-1)!['choices'] as Array<{ finish_reason: string }>
    expect(last[0]?.finish_reason).toBe('stop')
  })

  it('streams tool arguments as tool_calls deltas', () => {
    const completion = replyToChatCompletion(
      '{"tool_call": {"name": "get_time", "input": {"zone": "UTC"}}}',
      baseRequest({ tools: TOOLS }),
      {
        createdAt: CREATED_AT,
        fingerprint: FINGERPRINT,
        promptTokens: 4,
      },
    )
    const frames = buildChatCompletionChunks(completion, {
      includeUsage: false,
    })
    const openFrame = (
      frames[1]!['choices'] as Array<{
        delta: { tool_calls: Array<{ function: { name: string }; id: string }> }
      }>
    )[0]!
    expect(openFrame.delta.tool_calls[0]?.function.name).toBe('get_time')
    const argFrame = (
      frames[2]!['choices'] as Array<{
        delta: { tool_calls: Array<{ function: { arguments: string } }> }
      }>
    )[0]!
    expect(
      JSON.parse(argFrame.delta.tool_calls[0]!.function.arguments),
    ).toEqual({
      zone: 'UTC',
    })
    const last = frames.at(-1)!['choices'] as Array<{ finish_reason: string }>
    expect(last[0]?.finish_reason).toBe('tool_calls')
  })

  it('appends a usage-only frame when the client asks for usage', () => {
    const completion = replyToChatCompletion('short', baseRequest(), {
      createdAt: CREATED_AT,
      fingerprint: FINGERPRINT,
      promptTokens: 4,
    })
    const frames = buildChatCompletionChunks(completion, { includeUsage: true })
    const usageFrame = frames.at(-1)!
    expect(usageFrame['choices']).toEqual([])
    expect(usageFrame['usage']).toEqual(completion.usage)
  })
})

describe('toModelList', () => {
  it('reports one model owned by odai', () => {
    expect(toModelList('llama-server', CREATED_AT)).toEqual({
      data: [
        {
          created: CREATED_AT,
          id: 'llama-server',
          meta: JSON.parse('null'),
          object: 'model',
          owned_by: 'odai',
        },
      ],
      object: 'list',
    })
  })
})
