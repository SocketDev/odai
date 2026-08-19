/**
 * @file Loopback shim server. Serves both wire formats llama-server does over
 *   any registry backend: the Anthropic Messages routes, so an
 *   Anthropic-speaking agent — Claude Code via ANTHROPIC_BASE_URL — runs
 *   against local inference with no key, and the OpenAI chat-completions
 *   routes, so anything pointed at an OpenAI base URL sees odai as the
 *   llama-server it would otherwise talk to. Node-only. The backend is
 *   selected once at startup through the normal registry precedence; each
 *   request clones a fresh session and prompts the flattened conversation with
 *   decoding pinned greedy, then replies as one JSON object or as that
 *   format's SSE sequence. Loopback binding is asserted, mirroring the
 *   llama-server doctrine: the shim never listens on a routable interface.
 */

import { createServer } from 'node:http'

import { errorMessage } from '@socketsecurity/lib/errors/message'

import { selectBackend } from '../backends/registry.mts'
import { createWithFallback } from '../session.mts'
import { destroySession } from '../model.mts'
import { replyToMessage, toBackendMessages } from './anthropic.mts'
import {
  buildChatCompletionChunks,
  openAiToBackendMessages,
  replyToChatCompletion,
  toModelList,
} from './openai.mts'
import { estimateTokens } from './protocol.mts'
import { buildSseFrames } from './sse.mts'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { BackendName, OdaiBackend } from '../backends/types.mts'
import type { LanguageModelLike, Message, SessionLike } from '../types.mts'
import type { AnthropicMessagesRequest } from './anthropic.mts'
import type { OpenAiChatRequest } from './openai.mts'

const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024

const LOOPBACK_HOSTNAMES = new Set(['::1', '127.0.0.1', 'localhost'])

const MS_PER_SECOND = 1000

/**
 * Which error envelope a route answers with. The two formats disagree: an
 * Anthropic client reads `{type: "error", error: {...}}`, an OpenAI one reads
 * `{error: {code, message, type}}`.
 */
export type ErrorFormat = 'anthropic' | 'openai'

export interface ShimServerHandle {
  backendName: BackendName
  close(): Promise<void>
  port: number
  url: string
}

export interface ShimServerOptions {
  /**
   * Explicit backend instance. Wins over registry selection; the test injection
   * point.
   */
  backend?: OdaiBackend | undefined
  /**
   * Registry backend name passed to selection when no instance is given.
   */
  backendName?: BackendName | undefined
  /**
   * Env source for registry selection, `process.env` by default.
   */
  env?: Record<string, string | undefined> | undefined
  /**
   * Bind hostname, 127.0.0.1 by default. Must be loopback.
   */
  hostname?: string | undefined
  /**
   * Diagnostic line sink. Silent by default; the serve entry wires stderr.
   */
  log?: ((line: string) => void) | undefined
  /**
   * Bind port. 0 by default: the OS picks a free port.
   */
  port?: number | undefined
}

export interface ShimState {
  factory: LanguageModelLike
  log: (line: string) => void
  /**
   * What `/v1/models` reports and what an OpenAI request that names no model
   * falls back to. The selected backend's name — llama-server serves one
   * model and ignores the field, and so does the shim.
   */
  modelId: string
}

export interface WriteErrorOptions {
  errorType: string
  format: ErrorFormat
  message: string
  status: number
}

export class ShimRequestError extends Error {
  errorType: string
  status: number
  constructor(status: number, errorType: string, message: string) {
    super(message)
    this.errorType = errorType
    this.status = status
  }
}

/**
 * The error envelope a path answers with. The OpenAI routes are the
 * chat-completions family and the model list; everything else is Anthropic.
 */
export function errorFormatFor(pathname: string): ErrorFormat {
  return pathname.startsWith('/chat/') ||
    pathname.startsWith('/v1/chat/') ||
    pathname === '/models' ||
    pathname === '/v1/models'
    ? 'openai'
    : 'anthropic'
}

export async function handleChatCompletions(
  state: ShimState,
  body: string,
  response: ServerResponse,
): Promise<void> {
  const parsed = parseChatCompletionsRequest(body, state.modelId)
  const messages = openAiToBackendMessages(parsed)
  const promptTokens = estimateTokens(joinContent(messages))
  state.log(
    `POST /v1/chat/completions model=${parsed.model} ` +
      `turns=${parsed.messages.length} tools=${parsed.tools?.length ?? 0} ` +
      `stream=${parsed.stream === true} input~${promptTokens}tok`,
  )
  const raw = await promptOnce(state, messages)
  const completion = replyToChatCompletion(raw, parsed, {
    createdAt: nowSeconds(),
    fingerprint: `odai-${state.modelId}`,
    promptTokens,
  })
  const choice = completion.choices[0]!
  state.log(
    `  -> finish_reason=${choice.finish_reason} output~` +
      `${completion.usage.completion_tokens}tok ` +
      (choice.message.tool_calls === undefined
        ? ''
        : `tool=${choice.message.tool_calls[0]!.function.name}`),
  )
  if (parsed.stream !== true) {
    writeJson(response, 200, completion)
    return
  }
  const includeUsage = parsed.stream_options?.include_usage === true
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-type': 'text/event-stream',
  })
  const frames = buildChatCompletionChunks(completion, { includeUsage })
  for (const frame of frames) {
    response.write(`data: ${JSON.stringify(frame)}\n\n`)
  }
  response.write('data: [DONE]\n\n')
  response.end()
}

export async function handleMessages(
  state: ShimState,
  body: string,
  response: ServerResponse,
): Promise<void> {
  const parsed = parseMessagesRequest(body)
  const messages = toBackendMessages(parsed)
  const inputTokens = estimateTokens(joinContent(messages))
  state.log(
    `POST /v1/messages model=${parsed.model} turns=${parsed.messages.length} ` +
      `tools=${parsed.tools?.length ?? 0} stream=${parsed.stream === true} ` +
      `input~${inputTokens}tok`,
  )
  const raw = await promptOnce(state, messages)
  const message = replyToMessage(raw, parsed, inputTokens)
  state.log(
    `  -> stop_reason=${message.stop_reason} output~` +
      `${message.usage.output_tokens}tok ` +
      (message.content[0]?.type === 'tool_use'
        ? `tool=${(message.content[0] as { name: string }).name}`
        : ''),
  )
  if (parsed.stream !== true) {
    writeJson(response, 200, message)
    return
  }
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-type': 'text/event-stream',
  })
  for (const frame of buildSseFrames(message)) {
    response.write(`event: ${frame.event}\ndata: ${frame.data}\n\n`)
  }
  response.end()
}

export async function handleRequest(
  state: ShimState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const pathname = (request.url ?? '').split('?')[0] ?? ''
  const format = errorFormatFor(pathname)
  try {
    if (request.method === 'GET') {
      if (pathname === '/health' || pathname === '/v1/health') {
        writeJson(response, 200, { status: 'ok' })
        return
      }
      if (pathname === '/models' || pathname === '/v1/models') {
        writeJson(response, 200, toModelList(state.modelId, nowSeconds()))
        return
      }
    }
    if (request.method !== 'POST') {
      writeError(response, {
        errorType: 'not_found_error',
        format,
        message: `No route for ${pathname}.`,
        status: 404,
      })
      return
    }
    const body = await readBody(request)
    switch (pathname) {
      // llama-server registers the OpenAI routes at both the bare and the
      // `/v1` path, and its own test suite posts to the bare one.
      case '/chat/completions':
      case '/v1/chat/completions':
        await handleChatCompletions(state, body, response)
        return
      case '/chat/completions/input_tokens':
      case '/v1/chat/completions/input_tokens': {
        const parsed = parseChatCompletionsRequest(body, state.modelId)
        writeJson(response, 200, {
          input_tokens: estimateTokens(
            joinContent(openAiToBackendMessages(parsed)),
          ),
          object: 'response.input_tokens',
        })
        return
      }
      case '/v1/messages':
        await handleMessages(state, body, response)
        return
      case '/v1/messages/count_tokens': {
        const parsed = parseMessagesRequest(body)
        writeJson(response, 200, {
          input_tokens: estimateTokens(joinContent(toBackendMessages(parsed))),
        })
        return
      }
      default:
        writeError(response, {
          errorType: 'not_found_error',
          format,
          message: `No route for ${pathname}.`,
          status: 404,
        })
        return
    }
  } catch (error) {
    if (error instanceof ShimRequestError) {
      writeError(response, {
        errorType: error.errorType,
        format,
        message: error.message,
        status: error.status,
      })
      return
    }
    state.log(`shim request failed: ${errorMessage(error)}`)
    writeError(response, {
      errorType: 'api_error',
      format,
      message: errorMessage(error),
      status: 500,
    })
  }
}

export function joinContent(messages: readonly Message[]): string {
  return messages.map(message => message.content).join('\n')
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / MS_PER_SECOND)
}

/**
 * Parse a chat-completions body. `model` is optional, as it is on
 * llama-server: a single-model server has nothing to route, so an absent field
 * takes the shim's own model id rather than failing the request.
 */
export function parseChatCompletionsRequest(
  body: string,
  fallbackModel: string,
): OpenAiChatRequest {
  const record = parseJsonObject(body)
  if (!Array.isArray(record['messages']) || record['messages'].length === 0) {
    throw new ShimRequestError(
      400,
      'invalid_request_error',
      'messages must be a non-empty array.',
    )
  }
  const model = record['model']
  return {
    ...record,
    model: typeof model === 'string' && model !== '' ? model : fallbackModel,
  } as unknown as OpenAiChatRequest
}

export function parseJsonObject(body: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new ShimRequestError(
      400,
      'invalid_request_error',
      'Request body is not valid JSON.',
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ShimRequestError(
      400,
      'invalid_request_error',
      'Request body must be a JSON object.',
    )
  }
  return parsed as Record<string, unknown>
}

export function parseMessagesRequest(body: string): AnthropicMessagesRequest {
  const record = parseJsonObject(body)
  if (!Array.isArray(record['messages']) || record['messages'].length === 0) {
    throw new ShimRequestError(
      400,
      'invalid_request_error',
      'messages must be a non-empty array.',
    )
  }
  if (typeof record['model'] !== 'string' || record['model'] === '') {
    throw new ShimRequestError(
      400,
      'invalid_request_error',
      'model must be a non-empty string.',
    )
  }
  return record as unknown as AnthropicMessagesRequest
}

/**
 * One turn against a fresh session: decoding is pinned greedy so a request
 * replays identically, and the session is destroyed whether the prompt
 * succeeded or threw.
 */
export async function promptOnce(
  state: ShimState,
  messages: Message[],
): Promise<string> {
  const session: SessionLike = await createWithFallback(state.factory, {
    temperature: 0,
    topK: 1,
  })
  try {
    return await session.prompt(messages)
  } finally {
    destroySession(session)
  }
}

export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > DEFAULT_MAX_BODY_BYTES) {
      throw new ShimRequestError(
        413,
        'invalid_request_error',
        'Request body exceeds the shim size limit.',
      )
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function startShimServer(
  options?: ShimServerOptions | undefined,
): Promise<ShimServerHandle> {
  const opts = { __proto__: null, ...options } as ShimServerOptions
  const hostname = opts.hostname ?? '127.0.0.1'
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Shim hostname "${hostname}" is not loopback. The shim is ` +
        'local-only and refuses to listen on a routable interface.',
    )
  }
  const log = opts.log ?? (() => undefined)
  const backend =
    opts.backend ??
    (await selectBackend({
      ...(opts.backendName === undefined ? {} : { backend: opts.backendName }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
    }))
  const factory = await backend.languageModel()
  const state: ShimState = { factory, log, modelId: backend.name }
  const server: Server = createServer((request, response) => {
    void handleRequest(state, request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, hostname, resolve)
  })
  const address = server.address()
  const port =
    address !== null && typeof address === 'object' ? address.port : 0
  const url = `http://${hostname}:${port}`
  log(`shim listening at ${url} over backend "${backend.name}"`)
  return {
    backendName: backend.name,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error === undefined ? resolve() : reject(error)))
      })
      const closeable = backend as {
        close?: (() => Promise<void>) | undefined
      }
      await closeable.close?.().catch(() => undefined)
    },
    port,
    url,
  }
}

export function writeError(
  response: ServerResponse,
  options: WriteErrorOptions,
): void {
  const { errorType, format, message, status } = {
    __proto__: null,
    ...options,
  } as typeof options
  writeJson(
    response,
    status,
    format === 'openai'
      ? { error: { code: status, message, type: errorType } }
      : { error: { message, type: errorType }, type: 'error' },
  )
}

export function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const text = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(text)
}
