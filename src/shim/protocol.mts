/**
 * @file Protocol-neutral shim translation. The pieces both wire formats need:
 *   the prompt-engineered tool protocol a plain-text backend is taught, the
 *   hardened reader that finds a tool call in a reply, the token estimate, the
 *   id generator, and the text chunker streaming uses. Pure functions only, so
 *   the Anthropic and OpenAI modules stay siblings — neither imports the other.
 */

import { normalizeJsonPunctuation, repairJson } from '../json.mts'

/**
 * Rough chars-per-token divisor for usage estimates. The shim never sees the
 * backend tokenizer, so usage numbers are estimates by construction.
 */
const CHARS_PER_TOKEN = 4

const TOOL_ID_RADIX = 36
const TOOL_ID_SLICE = 10

/**
 * A tool as the protocol prompt needs it: a name, optional prose, and an
 * optional JSON schema. Both wire formats narrow to this — Anthropic's
 * `input_schema` and OpenAI's `function.parameters` are the same field.
 */
export interface ProtocolTool {
  description?: string | undefined
  input_schema?: unknown | undefined
  name: string
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
export function buildToolProtocol(tools: readonly ProtocolTool[]): string {
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
 * Split text into streaming-sized pieces. Empty text yields no pieces, so a
 * blank reply streams no delta frames at all.
 */
export function chunkText(text: string, size = 120): string[] {
  if (text === '') {
    return []
  }
  const pieces: string[] = []
  for (let i = 0; i < text.length; i += size) {
    pieces.push(text.slice(i, i + size))
  }
  return pieces
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
 * Mint a namespaced id. The separator is the wire format's: Anthropic spells
 * `msg_...` and `toolu_...`, OpenAI spells `chatcmpl-...` and `call-...`.
 */
export function newId(prefix: string, separator = '_'): string {
  const entropy = () =>
    Math.random().toString(TOOL_ID_RADIX).slice(2, TOOL_ID_SLICE)
  return `${prefix}${separator}${entropy()}${entropy()}`
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
