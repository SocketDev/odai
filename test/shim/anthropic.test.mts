import { describe, expect, it } from 'vitest'

import {
  flattenContent,
  flattenSystem,
  replyToMessage,
  toBackendMessages,
} from '../../src/shim/anthropic.mts'
import type { AnthropicMessagesRequest } from '../../src/shim/anthropic.mts'

function baseRequest(
  overrides: Partial<AnthropicMessagesRequest> = {},
): AnthropicMessagesRequest {
  return {
    max_tokens: 512,
    messages: [{ content: 'hello', role: 'user' }],
    model: 'claude-sonnet-4-5',
    ...overrides,
  }
}

describe('flattenSystem', () => {
  it('passes a plain string through', () => {
    expect(flattenSystem('be terse')).toBe('be terse')
  })

  it('joins text blocks and ignores cache_control', () => {
    const system = [
      { cache_control: { type: 'ephemeral' }, text: 'part one', type: 'text' },
      { text: 'part two', type: 'text' },
    ]
    expect(flattenSystem(system)).toBe('part one\npart two')
  })

  it('returns undefined for absent or empty system', () => {
    expect(flattenSystem(undefined)).toBeUndefined()
    expect(flattenSystem([])).toBeUndefined()
  })
})

describe('flattenContent', () => {
  it('inlines tool_use as the canonical protocol line', () => {
    const flattened = flattenContent([
      { text: 'calling now', type: 'text' },
      {
        id: 'toolu_1',
        input: { command: 'pwd' },
        name: 'Bash',
        type: 'tool_use',
      },
    ])
    expect(flattened).toBe(
      'calling now\n{"tool_call":{"input":{"command":"pwd"},"name":"Bash"}}',
    )
  })

  it('tags tool_result blocks with the id and error flag', () => {
    const flattened = flattenContent([
      {
        content: [{ text: '/tmp/example', type: 'text' }],
        tool_use_id: 'toolu_1',
        type: 'tool_result',
      },
      {
        content: 'boom',
        is_error: true,
        tool_use_id: 'toolu_2',
        type: 'tool_result',
      },
    ])
    expect(flattened).toBe(
      '[tool_result id=toolu_1]\n/tmp/example\n[tool_result id=toolu_2 error]\nboom',
    )
  })

  it('names and drops image blocks', () => {
    expect(flattenContent([{ source: {}, type: 'image' }])).toBe(
      '[image omitted]',
    )
  })
})

describe('toBackendMessages', () => {
  it('folds system and tool protocol into one system message', () => {
    const request = baseRequest({
      system: 'be terse',
      tools: [
        {
          description: 'Run a shell command.',
          input_schema: { properties: { command: { type: 'string' } } },
          name: 'Bash',
        },
      ],
    })
    const messages = toBackendMessages(request)
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('be terse')
    expect(messages[0]?.content).toContain('# Tool protocol')
    expect(messages[0]?.content).toContain('### Bash')
    expect(messages[0]?.content).toContain('Run a shell command.')
    expect(messages[1]).toEqual({ content: 'hello', role: 'user' })
  })

  it('emits no system message when neither system nor tools exist', () => {
    const messages = toBackendMessages(baseRequest())
    expect(messages).toEqual([{ content: 'hello', role: 'user' }])
  })
})

describe('replyToMessage', () => {
  it('produces a tool_use block with a fresh id and tool_use stop_reason', () => {
    const request = baseRequest({
      tools: [{ name: 'Bash' }],
    })
    const message = replyToMessage(
      '{"tool_call": {"name": "Bash", "input": {"command": "pwd"}}}',
      request,
      42,
    )
    expect(message.stop_reason).toBe('tool_use')
    expect(message.content).toHaveLength(1)
    const block = message.content[0]!
    expect(block.type).toBe('tool_use')
    if (block.type === 'tool_use') {
      expect(block.name).toBe('Bash')
      expect(block.input).toEqual({ command: 'pwd' })
      expect(block.id).toMatch(/^toolu_/)
    }
    expect(message.usage.input_tokens).toBe(42)
  })

  it('produces a text block with end_turn otherwise', () => {
    const message = replyToMessage('just an answer', baseRequest(), 7)
    expect(message.stop_reason).toBe('end_turn')
    expect(message.content).toEqual([{ text: 'just an answer', type: 'text' }])
  })

  it('applies stop_sequences with truncation', () => {
    const message = replyToMessage(
      'keep this STOP drop this',
      baseRequest({ stop_sequences: ['STOP'] }),
      7,
    )
    expect(message.stop_reason).toBe('stop_sequence')
    expect(message.stop_sequence).toBe('STOP')
    expect(message.content).toEqual([{ text: 'keep this ', type: 'text' }])
  })
})

describe('flattenContent edge cases', () => {
  it('returns empty string for a non-array, non-string content', () => {
    expect(flattenContent(42)).toBe('')
    expect(flattenContent({ not: 'a block array' })).toBe('')
  })

  it('skips unrecognized block types', () => {
    expect(
      flattenContent([{ type: 'thinking' }, { text: 'kept', type: 'text' }]),
    ).toBe('kept')
  })

  it('defaults a tool_use block with no input to an empty object', () => {
    expect(flattenContent([{ name: 'Bash', type: 'tool_use' }])).toBe(
      '{"tool_call":{"input":{},"name":"Bash"}}',
    )
  })
})
