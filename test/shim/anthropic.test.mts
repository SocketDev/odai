import { describe, expect, it } from 'vitest'

import {
  buildToolProtocol,
  closeUnbalancedJson,
  estimateTokens,
  extractToolCall,
  flattenContent,
  flattenSystem,
  newId,
  replyToMessage,
  toBackendMessages,
  unwrapToolCall,
} from '../../src/shim/anthropic.mts'
import type { AnthropicMessagesRequest } from '../../src/shim/anthropic.mts'

const TOOL_NAMES = new Set(['Bash', 'get_time'])

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
        content: [{ text: '/tmp/x', type: 'text' }],
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
      '[tool_result id=toolu_1]\n/tmp/x\n[tool_result id=toolu_2 error]\nboom',
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

describe('extractToolCall', () => {
  it('accepts the canonical envelope', () => {
    const call = extractToolCall(
      '{"tool_call": {"name": "Bash", "input": {"command": "pwd"}}}',
      TOOL_NAMES,
    )
    expect(call).toEqual({ input: { command: 'pwd' }, name: 'Bash' })
  })

  it('accepts the bare name/input shape', () => {
    const call = extractToolCall(
      '{"name": "get_time", "input": {}}',
      TOOL_NAMES,
    )
    expect(call).toEqual({ input: {}, name: 'get_time' })
  })

  it('strips code fences', () => {
    const call = extractToolCall(
      '```json\n{"tool_call": {"name": "Bash", "input": {"command": "ls"}}}\n```',
      TOOL_NAMES,
    )
    expect(call).toEqual({ input: { command: 'ls' }, name: 'Bash' })
  })

  it('repairs fullwidth punctuation and trailing prose', () => {
    const call = extractToolCall(
      '{"tool_call"：{"name"："Bash"，"input"：{}}} extra words',
      TOOL_NAMES,
    )
    expect(call).toEqual({ input: {}, name: 'Bash' })
  })

  it('closes an under-terminated tool call, as observed live from Qwen 7B', () => {
    const call = extractToolCall(
      '{"tool_call": {"name": "get_time", "input": {"zone": "UTC"}}',
      TOOL_NAMES,
    )
    expect(call).toEqual({ input: { zone: 'UTC' }, name: 'get_time' })
  })

  it('closes a call truncated inside the input object', () => {
    const call = extractToolCall(
      '{"tool_call": {"name": "Bash", "input": {"command": "pwd"}',
      TOOL_NAMES,
    )
    expect(call).toEqual({ input: { command: 'pwd' }, name: 'Bash' })
  })

  it('rejects a call truncated inside a string value', () => {
    const call = extractToolCall(
      '{"tool_call": {"name": "Bash", "input": {"command": "pw',
      TOOL_NAMES,
    )
    expect(call).toBeUndefined()
  })

  it('rejects prose that merely quotes JSON', () => {
    const call = extractToolCall(
      'You could run {"tool_call": {"name": "Bash", "input": {}}} if needed.',
      TOOL_NAMES,
    )
    expect(call).toBeUndefined()
  })

  it('rejects undeclared tool names', () => {
    const call = extractToolCall(
      '{"tool_call": {"name": "Nuke", "input": {}}}',
      TOOL_NAMES,
    )
    expect(call).toBeUndefined()
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

describe('estimateTokens', () => {
  it('estimates at least one token', () => {
    expect(estimateTokens('')).toBe(1)
    expect(estimateTokens('x'.repeat(400))).toBe(100)
  })
})

describe('buildToolProtocol', () => {
  it('documents every tool with schema', () => {
    const protocol = buildToolProtocol([
      { description: 'Tell the time.', input_schema: {}, name: 'get_time' },
      { name: 'Bash' },
    ])
    expect(protocol).toContain('### get_time')
    expect(protocol).toContain('Tell the time.')
    expect(protocol).toContain('Input JSON schema: {}')
    expect(protocol).toContain('### Bash')
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

describe('closeUnbalancedJson', () => {
  it('returns undefined when there is no object start', () => {
    expect(closeUnbalancedJson('no braces here')).toBeUndefined()
  })

  it('returns undefined for already-balanced JSON', () => {
    expect(closeUnbalancedJson('{"a":1}')).toBeUndefined()
  })

  it('closes a nested object short one brace', () => {
    expect(closeUnbalancedJson('{"a":{"b":1}')).toBe('{"a":{"b":1}}')
  })

  it('closes an object with an unterminated array', () => {
    expect(closeUnbalancedJson('{"a":[1,2')).toBe('{"a":[1,2]}')
  })

  it('ignores braces inside strings and escapes', () => {
    expect(closeUnbalancedJson('{"a":"has } and \\" quote"')).toBe(
      '{"a":"has } and \\" quote"}',
    )
  })

  it('returns undefined when a closer does not match its opener', () => {
    expect(closeUnbalancedJson('{"a":[1}')).toBeUndefined()
  })

  it('returns undefined when the text ends inside a string', () => {
    expect(closeUnbalancedJson('{"a":"open')).toBeUndefined()
  })
})

describe('unwrapToolCall', () => {
  it('returns undefined for null, arrays, and non-objects', () => {
    // A JSON-parsed null models a backend reply that parses to JSON null.
    expect(unwrapToolCall(JSON.parse('null'))).toBeUndefined()
    expect(unwrapToolCall([1, 2])).toBeUndefined()
    expect(unwrapToolCall('str')).toBeUndefined()
  })

  it('returns undefined when the inner tool_call is null', () => {
    // A model can emit {"tool_call": null}; the parser must screen it out.
    expect(unwrapToolCall({ tool_call: JSON.parse('null') })).toBeUndefined()
  })

  it('returns undefined when the name is missing or empty', () => {
    expect(unwrapToolCall({ input: {} })).toBeUndefined()
    expect(unwrapToolCall({ name: '' })).toBeUndefined()
  })

  it('coerces a non-object input to an empty object', () => {
    expect(unwrapToolCall({ input: 'nope', name: 'Bash' })).toEqual({
      input: {},
      name: 'Bash',
    })
  })

  it('returns undefined when the tool_call wrapper is not an object', () => {
    expect(unwrapToolCall({ tool_call: 5 })).toBeUndefined()
  })
})

describe('extractToolCall failure paths', () => {
  it('returns undefined when nothing parses into an object', () => {
    expect(extractToolCall('{ this is not json at all ', TOOL_NAMES)).toBe(
      undefined,
    )
  })

  it('returns undefined when every repair attempt leaves it unparseable', () => {
    expect(extractToolCall('{{{', TOOL_NAMES)).toBeUndefined()
  })
})

describe('newId', () => {
  it('prefixes an id with the given namespace', () => {
    expect(newId('toolu')).toMatch(/^toolu_[a-z0-9]+$/)
  })
})
