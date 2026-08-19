/**
 * @file OpenAI chat-completions translation for the loopback shim, so odai
 *   presents the same surface it consumes from llama-server. Pure functions
 *   only: flatten a `POST /v1/chat/completions` body into odai's plain
 *   `Message[]`, read the reply back as a `chat.completion` object, and replay
 *   a finished completion as `chat.completion.chunk` frames. Tool calling
 *   rides the shared prompt-engineered protocol in `protocol.mts`, so an
 *   OpenAI client's `tools` and a Messages client's `tools` reach the backend
 *   identically and come back in their own wire shape.
 */

import {
  buildToolProtocol,
  chunkText,
  estimateTokens,
  extractToolCall,
  newId,
} from './protocol.mts'
import type { ProtocolTool } from './protocol.mts'
import type { Message } from '../types.mts'

/**
 * `owned_by` for the single model `/v1/models` reports. llama-server answers
 * `llamacpp`; odai answers for itself, because the backend behind it can be
 * Chrome's built-in model or Apple's on-device one, not only llama.cpp.
 */
const MODEL_OWNER = 'odai'

export interface OpenAiFunctionSpec {
  description?: string | undefined
  name: string
  parameters?: unknown | undefined
}

export interface OpenAiTool {
  function: OpenAiFunctionSpec
  type: 'function'
}

export interface OpenAiToolCall {
  function: { arguments: string; name: string }
  id: string
  type: 'function'
}

export interface OpenAiRequestMessage {
  content: unknown
  role: 'assistant' | 'developer' | 'system' | 'tool' | 'user'
  tool_call_id?: string | undefined
  tool_calls?: OpenAiToolCall[] | undefined
}

export interface OpenAiChatRequest {
  max_completion_tokens?: number | undefined
  max_tokens?: number | undefined
  messages: OpenAiRequestMessage[]
  model: string
  stop?: string | string[] | undefined
  stream?: boolean | undefined
  stream_options?: { include_usage?: boolean | undefined } | undefined
  temperature?: number | undefined
  tools?: OpenAiTool[] | undefined
  top_k?: number | undefined
}

export interface OpenAiChoiceMessage {
  content: string | null
  role: 'assistant'
  tool_calls?: OpenAiToolCall[] | undefined
}

export type OpenAiFinishReason = 'stop' | 'tool_calls'

export interface OpenAiChoice {
  finish_reason: OpenAiFinishReason
  index: number
  logprobs: null
  message: OpenAiChoiceMessage
}

export interface OpenAiUsage {
  completion_tokens: number
  prompt_tokens: number
  total_tokens: number
}

export interface OpenAiChatCompletion {
  choices: OpenAiChoice[]
  created: number
  id: string
  model: string
  object: 'chat.completion'
  /**
   * Which server produced the reply. llama-server answers with its build
   * string; odai answers with its own name and the backend behind it.
   */
  system_fingerprint: string
  usage: OpenAiUsage
}

export interface ChatCompletionOptions {
  /**
   * Unix seconds stamped into the reply. Passed in so the translation stays
   * pure and a test can assert an exact value.
   */
  createdAt: number
  fingerprint: string
  promptTokens: number
}

export interface OpenAiModelEntry {
  created: number
  id: string
  meta: null
  object: 'model'
  owned_by: string
}

export interface OpenAiModelList {
  data: OpenAiModelEntry[]
  object: 'list'
}

export interface BuildChunkOptions {
  /**
   * Append a usage-only final frame, which an OpenAI client asks for through
   * `stream_options.include_usage`.
   */
  includeUsage: boolean
}

/**
 * Replay a finished completion as the streaming frame sequence: a role frame,
 * the content or tool-argument deltas, then a frame carrying finish_reason.
 * The reply is complete before the first frame goes out, because tool-call
 * detection needs the whole text. Usage rides the last frame only when the
 * client asked for it through `stream_options.include_usage`, matching what
 * an OpenAI client expects.
 */
export function buildChatCompletionChunks(
  completion: OpenAiChatCompletion,
  options: BuildChunkOptions,
): Array<Record<string, unknown>> {
  const opts = { __proto__: null, ...options } as typeof options
  const choice = completion.choices[0]!
  const envelope = {
    created: completion.created,
    id: completion.id,
    model: completion.model,
    object: 'chat.completion.chunk',
    system_fingerprint: completion.system_fingerprint,
  }
  const frames: Array<Record<string, unknown>> = [
    {
      ...envelope,
      // The opening frame carries an explicit null content beside the role,
      // which is the shape llama-server sends and an OpenAI client reads.
      // oxlint-disable-next-line socket/prefer-undefined-over-null -- chat.completion.chunk wire format
      choices: [openStreamChoice({ content: null, role: 'assistant' })],
    },
  ]
  const pushDelta = (delta: Record<string, unknown>): void => {
    frames.push({ ...envelope, choices: [openStreamChoice(delta)] })
  }
  const toolCall = choice.message.tool_calls?.[0]
  if (toolCall === undefined) {
    for (const piece of chunkText(choice.message.content ?? '')) {
      pushDelta({ content: piece })
    }
  } else {
    pushDelta({
      tool_calls: [
        {
          function: { arguments: '', name: toolCall.function.name },
          id: toolCall.id,
          index: 0,
          type: 'function',
        },
      ],
    })
    for (const piece of chunkText(toolCall.function.arguments)) {
      pushDelta({
        tool_calls: [{ function: { arguments: piece }, index: 0 }],
      })
    }
  }
  frames.push({
    ...envelope,
    choices: [{ delta: {}, finish_reason: choice.finish_reason, index: 0 }],
  })
  if (opts.includeUsage) {
    frames.push({ ...envelope, choices: [], usage: completion.usage })
  }
  return frames
}

/**
 * Flatten one OpenAI content value — a string or a typed part array — into
 * plain text. Image and audio parts are named and dropped, because the
 * session interface carries text only.
 */
export function flattenOpenAiContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const parts: string[] = []
  for (const part of content) {
    const record = part as Record<string, unknown>
    switch (record['type']) {
      case 'image_url':
        parts.push('[image omitted]')
        break
      case 'input_audio':
        parts.push('[audio omitted]')
        break
      case 'text':
        if (typeof record['text'] === 'string') {
          parts.push(record['text'])
        }
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/**
 * Translate the whole request into odai's `Message[]`. Every system and
 * developer message folds into one leading system message alongside the tool
 * protocol; an assistant turn's `tool_calls` are re-serialized as the
 * canonical protocol line, and a `tool` turn becomes the tagged
 * `[tool_result id=...]` section the protocol tells the model to expect.
 */
export function openAiToBackendMessages(request: OpenAiChatRequest): Message[] {
  const messages: Message[] = []
  const systemParts: string[] = []
  for (const turn of request.messages) {
    if (turn.role === 'developer' || turn.role === 'system') {
      const text = flattenOpenAiContent(turn.content)
      if (text !== '') {
        systemParts.push(text)
      }
    }
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    systemParts.push(buildToolProtocol(toProtocolTools(request.tools)))
  }
  if (systemParts.length > 0) {
    messages.push({ content: systemParts.join('\n\n'), role: 'system' })
  }
  for (const turn of request.messages) {
    if (turn.role === 'developer' || turn.role === 'system') {
      continue
    }
    if (turn.role === 'tool') {
      const id = turn.tool_call_id ?? 'unknown'
      const body = flattenOpenAiContent(turn.content)
      messages.push({
        content: `[tool_result id=${id}]\n${body}`,
        role: 'user',
      })
      continue
    }
    if (turn.role === 'assistant' && turn.tool_calls !== undefined) {
      const lines = turn.tool_calls.map(call =>
        JSON.stringify({
          tool_call: {
            input: parseArguments(call.function.arguments),
            name: call.function.name,
          },
        }),
      )
      const text = flattenOpenAiContent(turn.content)
      messages.push({
        content: [...(text === '' ? [] : [text]), ...lines].join('\n'),
        role: 'assistant',
      })
      continue
    }
    messages.push({
      content: flattenOpenAiContent(turn.content),
      role: turn.role === 'assistant' ? 'assistant' : 'user',
    })
  }
  return messages
}

/**
 * One choice of a frame that is still open: the wire format spells "not
 * finished yet" as an explicit null finish_reason.
 */
export function openStreamChoice(
  delta: Record<string, unknown>,
): Record<string, unknown> {
  return {
    delta,
    // oxlint-disable-next-line socket/prefer-undefined-over-null -- chat.completion.chunk wire format: an open frame carries an explicit null finish_reason.
    finish_reason: null,
    index: 0,
  }
}

/**
 * Parse a tool call's `arguments` string. OpenAI carries them as JSON text,
 * and a model that emitted something unparseable gets an empty object rather
 * than a request failure — the reply is history at this point, not a decision.
 */
export function parseArguments(raw: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }
  return parsed as Record<string, unknown>
}

/**
 * Build the completion object for a backend reply: detect a tool call, apply
 * the `stop` sequences, and pick the finish_reason.
 */
export function replyToChatCompletion(
  raw: string,
  request: OpenAiChatRequest,
  options: ChatCompletionOptions,
): OpenAiChatCompletion {
  const { createdAt, fingerprint, promptTokens } = {
    __proto__: null,
    ...options,
  } as ChatCompletionOptions
  const toolNames = new Set(
    (request.tools ?? []).map(tool => tool.function.name),
  )
  const toolCall =
    toolNames.size > 0 ? extractToolCall(raw, toolNames) : undefined
  let message: OpenAiChoiceMessage
  let finishReason: OpenAiFinishReason
  if (toolCall === undefined) {
    let text = raw
    for (const sequence of toStopSequences(request.stop)) {
      const at = text.indexOf(sequence)
      if (at !== -1) {
        text = text.slice(0, at)
      }
    }
    message = { content: text, role: 'assistant' }
    finishReason = 'stop'
  } else {
    message = {
      // oxlint-disable-next-line socket/prefer-undefined-over-null -- chat.completion wire format: a tool-call choice carries an explicit null content.
      content: null,
      role: 'assistant',
      tool_calls: [
        {
          function: {
            arguments: JSON.stringify(toolCall.input),
            name: toolCall.name,
          },
          id: newId('call', '-'),
          type: 'function',
        },
      ],
    }
    finishReason = 'tool_calls'
  }
  const completionTokens = estimateTokens(raw)
  return {
    choices: [
      {
        finish_reason: finishReason,
        index: 0,
        // oxlint-disable-next-line socket/prefer-undefined-over-null -- chat.completion wire format: logprobs is an explicit null when unrequested.
        logprobs: null,
        message,
      },
    ],
    created: createdAt,
    id: newId('chatcmpl', '-'),
    model: request.model,
    object: 'chat.completion',
    system_fingerprint: fingerprint,
    usage: {
      completion_tokens: completionTokens,
      prompt_tokens: promptTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

/**
 * The one-element `/v1/models` list. llama-server reports the loaded model
 * file; odai reports the selected backend, which is the closest true thing it
 * knows without prompting the model for its own name.
 */
export function toModelList(
  modelId: string,
  createdAt: number,
): OpenAiModelList {
  return {
    data: [
      {
        created: createdAt,
        id: modelId,
        // oxlint-disable-next-line socket/prefer-undefined-over-null -- /v1/models wire format: meta is null when no model metadata is known.
        meta: null,
        object: 'model',
        owned_by: MODEL_OWNER,
      },
    ],
    object: 'list',
  }
}

/**
 * Narrow OpenAI tool specs to the protocol prompt's shape. A non-function
 * tool has no plain-text meaning and is dropped.
 */
export function toProtocolTools(tools: readonly OpenAiTool[]): ProtocolTool[] {
  const narrowed: ProtocolTool[] = []
  for (const tool of tools) {
    const spec = tool.function
    if (spec === undefined || typeof spec.name !== 'string') {
      continue
    }
    narrowed.push({
      ...(spec.description === undefined
        ? {}
        : { description: spec.description }),
      ...(spec.parameters === undefined
        ? {}
        : { input_schema: spec.parameters }),
      name: spec.name,
    })
  }
  return narrowed
}

/**
 * Normalize `stop` to a list. OpenAI accepts one string or up to four.
 */
export function toStopSequences(stop: string | string[] | undefined): string[] {
  if (stop === undefined) {
    return []
  }
  return typeof stop === 'string' ? [stop] : stop
}
