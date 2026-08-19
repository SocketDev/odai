/**
 * @file Anthropic Messages translation for the loopback shim. Pure functions
 *   only: parse a `POST /v1/messages` body, flatten its system prompt and
 *   content blocks — text, tool_use, tool_result — into odai's plain
 *   `Message[]`, and read the reply back into Anthropic content blocks. The
 *   tool protocol, tool-call detection, token estimate, and id generator are
 *   protocol-neutral and live in `protocol.mts`.
 */

import {
  buildToolProtocol,
  estimateTokens,
  extractToolCall,
  newId,
} from './protocol.mts'
import type { Message } from '../types.mts'

export interface AnthropicTextBlock {
  text: string
  type: 'text'
}

export interface AnthropicToolUseBlock {
  id: string
  input: Record<string, unknown>
  name: string
  type: 'tool_use'
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock

export interface AnthropicTool {
  description?: string | undefined
  input_schema?: unknown | undefined
  name: string
}

export interface AnthropicRequestMessage {
  content: unknown
  role: 'assistant' | 'user'
}

export interface AnthropicMessagesRequest {
  max_tokens?: number | undefined
  messages: AnthropicRequestMessage[]
  model: string
  stop_sequences?: string[] | undefined
  stream?: boolean | undefined
  system?: unknown | undefined
  temperature?: number | undefined
  tools?: AnthropicTool[] | undefined
}

export interface AnthropicUsage {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  input_tokens: number
  output_tokens: number
}

export interface AnthropicMessageResult {
  content: AnthropicContentBlock[]
  id: string
  model: string
  role: 'assistant'
  stop_reason: 'end_turn' | 'stop_sequence' | 'tool_use'
  stop_sequence: string | null
  type: 'message'
  usage: AnthropicUsage
}

/**
 * Flatten one Anthropic content value — string or block array — into odai's
 * plain text. tool_use blocks in assistant history are re-serialized
 * as the canonical protocol line so the model sees its own past calls in the
 * same shape it must emit them; tool_result blocks become tagged
 * `[tool_result id=...]` sections; images are named and dropped.
 */
export function flattenContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const parts: string[] = []
  for (const block of content) {
    const record = block as Record<string, unknown>
    switch (record['type']) {
      case 'image':
        parts.push('[image omitted]')
        break
      case 'text':
        if (typeof record['text'] === 'string') {
          parts.push(record['text'])
        }
        break
      case 'tool_result': {
        const id =
          typeof record['tool_use_id'] === 'string'
            ? record['tool_use_id']
            : 'unknown'
        const errorTag = record['is_error'] === true ? ' error' : ''
        const body = flattenContent(record['content'])
        parts.push(`[tool_result id=${id}${errorTag}]\n${body}`)
        break
      }
      case 'tool_use': {
        const name = typeof record['name'] === 'string' ? record['name'] : ''
        const input =
          record['input'] !== undefined && record['input'] !== null
            ? record['input']
            : {}
        parts.push(JSON.stringify({ tool_call: { input, name } }))
        break
      }
      default:
        break
    }
  }
  return parts.join('\n')
}

export function flattenSystem(system: unknown): string | undefined {
  if (system === undefined || system === null) {
    return undefined
  }
  const text = flattenContent(system)
  return text === '' ? undefined : text
}

/**
 * Build the final Anthropic message for a backend reply: detect a tool call,
 * apply stop_sequences, and pick the stop_reason.
 */
export function replyToMessage(
  raw: string,
  request: AnthropicMessagesRequest,
  inputTokens: number,
): AnthropicMessageResult {
  const toolNames = new Set((request.tools ?? []).map(tool => tool.name))
  const toolCall =
    toolNames.size > 0 ? extractToolCall(raw, toolNames) : undefined
  let content: AnthropicContentBlock[]
  let stopReason: AnthropicMessageResult['stop_reason']
  let stopSequence: string | null = null
  if (toolCall !== undefined) {
    content = [
      {
        id: newId('toolu'),
        input: toolCall.input,
        name: toolCall.name,
        type: 'tool_use',
      },
    ]
    stopReason = 'tool_use'
  } else {
    let text = raw
    for (const sequence of request.stop_sequences ?? []) {
      const at = text.indexOf(sequence)
      if (at !== -1) {
        text = text.slice(0, at)
        stopReason = 'stop_sequence'
        stopSequence = sequence
      }
    }
    content = [{ text, type: 'text' }]
    stopReason = stopSequence === null ? 'end_turn' : 'stop_sequence'
  }
  return {
    content,
    id: newId('msg'),
    model: request.model,
    role: 'assistant',
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    type: 'message',
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: inputTokens,
      output_tokens: estimateTokens(raw),
    },
  }
}

/**
 * Translate the whole request into odai's `Message[]`. The system prompt
 * and the tool protocol land in one leading system message; every
 * conversation turn is flattened text with tool traffic inlined.
 */
export function toBackendMessages(
  request: AnthropicMessagesRequest,
): Message[] {
  const messages: Message[] = []
  const systemParts: string[] = []
  const system = flattenSystem(request.system)
  if (system !== undefined) {
    systemParts.push(system)
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    systemParts.push(buildToolProtocol(request.tools))
  }
  if (systemParts.length > 0) {
    messages.push({ content: systemParts.join('\n\n'), role: 'system' })
  }
  for (const turn of request.messages) {
    messages.push({
      content: flattenContent(turn.content),
      role: turn.role === 'assistant' ? 'assistant' : 'user',
    })
  }
  return messages
}
