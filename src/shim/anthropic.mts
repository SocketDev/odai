/**
 * @file Anthropic Messages translation for the loopback shim. Pure functions
 *   only: parse a `POST /v1/messages` body, flatten its system prompt and
 *   content blocks — text, tool_use, tool_result — into odai's plain
 *   `Message[]`, teach the backend a one-line JSON tool-call protocol, and
 *   read the reply back into Anthropic content blocks. Tool-call detection
 *   rides the existing JSON hardening: fence stripping, fullwidth punctuation
 *   repair, and balanced-object extraction.
 */

import { normalizeJsonPunctuation, repairJson } from '../json.mts'
import type { Message } from '../types.mts'

/**
 * Rough chars-per-token divisor for usage estimates. The shim never sees the
 * backend tokenizer, so usage numbers are estimates by construction.
 */
const CHARS_PER_TOKEN = 4

const TOOL_ID_RADIX = 36
const TOOL_ID_SLICE = 10

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

export interface ToolCall {
  input: Record<string, unknown>
  name: string
}

/**
 * The system-prompt section that teaches a plain-text backend the tool
 * protocol. The session interface carries text only, so tool calling is
 * prompt-engineered: the model answers either with prose or with exactly one
 * one-line JSON object naming a declared tool.
 */
export function buildToolProtocol(tools: AnthropicTool[]): string {
  const lines: string[] = [
    '# Tool protocol',
    '',
    'You can call the tools listed below. To call one, reply with ONLY a',
    'single JSON object on one line — no prose, no code fence, nothing else:',
    // Model-facing JSON template; a typographic ellipsis inside it would
    // corrupt the protocol example.
    // oxlint-disable-next-line socket/prefer-ellipsis-char -- protocol example
    '{"tool_call": {"name": "<tool name>", "input": { ...arguments... }}}',
    "The input object must match the tool's JSON schema.",
    'After a tool call, the next user message starts with',
    '[tool_result id=<id>] and contains the tool output; use it to continue.',
    'When you can answer without a tool, reply in plain text and never emit',
    'a tool_call object.',
    '',
    '## Tools',
  ]
  for (let i = 0, { length } = tools; i < length; i += 1) {
    const tool = tools[i]!
    lines.push('', `### ${tool.name}`)
    if (tool.description !== undefined && tool.description !== '') {
      lines.push(tool.description)
    }
    if (tool.input_schema !== undefined) {
      lines.push(`Input JSON schema: ${JSON.stringify(tool.input_schema)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Close an under-terminated JSON object. Observed live from
 * Qwen2.5-Coder-7B: the tool-call object arrives one `}` short, which strict
 * parsing and balanced-prefix extraction both reject. Walks from the first
 * `{` with string and escape tracking, then appends the closers the open
 * stack still needs. Returns undefined when the text has no object start,
 * ends inside a string, or is already balanced — the caller only uses this
 * as a last-resort reparse.
 */
export function closeUnbalancedJson(raw: string): string | undefined {
  const start = raw.indexOf('{')
  if (start === -1) {
    return undefined
  }
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      stack.push('}')
    } else if (char === '[') {
      stack.push(']')
    } else if (char === ']' || char === '}') {
      if (stack.pop() !== char) {
        return undefined
      }
      if (stack.length === 0) {
        return undefined
      }
    }
  }
  if (inString || stack.length === 0) {
    return undefined
  }
  return raw.slice(start) + stack.toReversed().join('')
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
}

/**
 * Detect a tool call in a backend reply. Accepts the canonical
 * `{"tool_call": {...}}` envelope and the bare `{"name": ..., "input": ...}`
 * shape, with or without a code fence, through the shared punctuation repair
 * and balanced-object extraction. A reply whose stripped form does not start
 * with `{` is prose, never a tool call — JSON quoted inside an explanation
 * must not fire.
 */
export function extractToolCall(
  raw: string,
  toolNames: ReadonlySet<string>,
): ToolCall | undefined {
  let trimmed = raw.trim()
  // Match a markdown code fence: opening ``` optionally followed by `json`,
  // then optional whitespace (\s*), then a lazy capture of any content
  // including newlines ([\s\S]*?), then the closing ```.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch && fenceMatch[1] !== undefined) {
    trimmed = fenceMatch[1].trim()
  }
  if (!trimmed.startsWith('{')) {
    return undefined
  }
  const tryParse = (text: string | undefined): unknown => {
    if (text === undefined) {
      return undefined
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  }
  let parsed: unknown = tryParse(trimmed)
  if (parsed === undefined) {
    const normalized = normalizeJsonPunctuation(trimmed)
    parsed = tryParse(normalized) ?? tryParse(repairJson(normalized))
    if (unwrapToolCall(parsed) === undefined) {
      const closed = tryParse(closeUnbalancedJson(normalized))
      if (closed !== undefined) {
        parsed = closed
      }
    }
  }
  if (parsed === undefined) {
    return undefined
  }
  const candidate = unwrapToolCall(parsed)
  if (candidate === undefined) {
    return undefined
  }
  if (!toolNames.has(candidate.name)) {
    return undefined
  }
  return candidate
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

export function newId(prefix: string): string {
  const entropy = () =>
    Math.random().toString(TOOL_ID_RADIX).slice(2, TOOL_ID_SLICE)
  return `${prefix}_${entropy()}${entropy()}`
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

export function unwrapToolCall(parsed: unknown): ToolCall | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }
  const record = parsed as Record<string, unknown>
  const inner =
    record['tool_call'] !== undefined && record['tool_call'] !== null
      ? record['tool_call']
      : record
  if (inner === null || typeof inner !== 'object') {
    return undefined
  }
  const call = inner as Record<string, unknown>
  const name = call['name']
  if (typeof name !== 'string' || name === '') {
    return undefined
  }
  const input = call['input']
  const inputRecord =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  return { input: inputRecord, name }
}
