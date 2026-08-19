/**
 * @file SSE encoding for the Anthropic shim. Turns one finished message into
 *   the streaming event sequence a Messages-API client expects. The reply is
 *   complete before the first frame is written — the shim replays it as SSE
 *   rather than proxying token deltas, because tool-call detection needs the
 *   whole reply.
 */

import { chunkText } from './protocol.mts'
import type { AnthropicMessageResult } from './anthropic.mts'

/**
 * One serialized SSE frame: the `event:` name plus the JSON `data:` payload.
 */
export interface SseFrame {
  data: string
  event: string
}

/**
 * Build the full event sequence: message_start, per-block
 * content_block_start/delta/stop, message_delta with stop_reason and usage,
 * message_stop. Text blocks stream as text_delta pieces; tool_use blocks
 * start with an empty input and stream the arguments as input_json_delta.
 */
export function buildSseFrames(message: AnthropicMessageResult): SseFrame[] {
  const frames: SseFrame[] = []
  frames.push({
    data: JSON.stringify({
      message: {
        content: [],
        id: message.id,
        model: message.model,
        role: 'assistant',
        // oxlint-disable-next-line socket/prefer-undefined-over-null -- Messages API wire format: message_start carries explicit nulls.
        stop_reason: null,
        // oxlint-disable-next-line socket/prefer-undefined-over-null -- Messages API wire format: message_start carries explicit nulls.
        stop_sequence: null,
        type: 'message',
        usage: { ...message.usage, output_tokens: 0 },
      },
      type: 'message_start',
    }),
    event: 'message_start',
  })
  for (let index = 0; index < message.content.length; index += 1) {
    const block = message.content[index]!
    if (block.type === 'text') {
      frames.push({
        data: JSON.stringify({
          content_block: { text: '', type: 'text' },
          index,
          type: 'content_block_start',
        }),
        event: 'content_block_start',
      })
      for (const piece of chunkText(block.text)) {
        frames.push({
          data: JSON.stringify({
            delta: { text: piece, type: 'text_delta' },
            index,
            type: 'content_block_delta',
          }),
          event: 'content_block_delta',
        })
      }
    } else {
      frames.push({
        data: JSON.stringify({
          content_block: {
            id: block.id,
            input: {},
            name: block.name,
            type: 'tool_use',
          },
          index,
          type: 'content_block_start',
        }),
        event: 'content_block_start',
      })
      for (const piece of chunkText(JSON.stringify(block.input))) {
        frames.push({
          data: JSON.stringify({
            delta: { partial_json: piece, type: 'input_json_delta' },
            index,
            type: 'content_block_delta',
          }),
          event: 'content_block_delta',
        })
      }
    }
    frames.push({
      data: JSON.stringify({ index, type: 'content_block_stop' }),
      event: 'content_block_stop',
    })
  }
  frames.push({
    data: JSON.stringify({
      delta: {
        stop_reason: message.stop_reason,
        stop_sequence: message.stop_sequence,
      },
      type: 'message_delta',
      usage: { output_tokens: message.usage.output_tokens },
    }),
    event: 'message_delta',
  })
  frames.push({
    data: JSON.stringify({ type: 'message_stop' }),
    event: 'message_stop',
  })
  return frames
}
