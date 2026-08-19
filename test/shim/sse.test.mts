import { describe, expect, it } from 'vitest'

import { replyToMessage } from '../../src/shim/anthropic.mts'
import { buildSseFrames } from '../../src/shim/sse.mts'
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

describe('buildSseFrames', () => {
  it('emits the full event sequence for a text reply', () => {
    const message = replyToMessage('short reply', baseRequest(), 5)
    const frames = buildSseFrames(message)
    expect(frames.map(frame => frame.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    const start = JSON.parse(frames[0]!.data) as {
      message: { stop_reason: null; usage: { output_tokens: number } }
    }
    expect(start.message.stop_reason).toBeNull()
    expect(start.message.usage.output_tokens).toBe(0)
    const delta = JSON.parse(frames[4]!.data) as {
      delta: { stop_reason: string }
      usage: { output_tokens: number }
    }
    expect(delta.delta.stop_reason).toBe('end_turn')
    expect(delta.usage.output_tokens).toBeGreaterThan(0)
  })

  it('streams tool_use input as input_json_delta frames', () => {
    const request = baseRequest({ tools: [{ name: 'Bash' }] })
    const message = replyToMessage(
      '{"tool_call": {"name": "Bash", "input": {"command": "pwd"}}}',
      request,
      5,
    )
    const frames = buildSseFrames(message)
    const startFrame = frames.find(
      frame => frame.event === 'content_block_start',
    )!
    const start = JSON.parse(startFrame.data) as {
      content_block: { input: object; name: string; type: string }
    }
    expect(start.content_block.type).toBe('tool_use')
    expect(start.content_block.name).toBe('Bash')
    expect(start.content_block.input).toEqual({})
    const deltas = frames.filter(frame => frame.event === 'content_block_delta')
    const joined = deltas
      .map(
        frame =>
          (JSON.parse(frame.data) as { delta: { partial_json: string } }).delta
            .partial_json,
      )
      .join('')
    expect(JSON.parse(joined)).toEqual({ command: 'pwd' })
  })
})
