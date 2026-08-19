import { describe, expect, it } from 'vitest'

import {
  buildToolProtocol,
  chunkText,
  closeUnbalancedJson,
  estimateTokens,
  extractToolCall,
  newId,
  unwrapToolCall,
} from '../../src/shim/protocol.mts'

const TOOL_NAMES = new Set(['Bash', 'get_time'])

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

describe('chunkText', () => {
  it('chunks text and reassembles losslessly', () => {
    const text = 'x'.repeat(301)
    const pieces = chunkText(text, 120)
    expect(pieces).toHaveLength(3)
    expect(pieces.join('')).toBe(text)
    expect(chunkText('')).toEqual([])
  })
})
