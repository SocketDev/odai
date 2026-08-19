/**
 * @file Loopback Anthropic Messages shim server. Serves `POST /v1/messages`
 *   over any registry backend so an Anthropic-speaking agent — Claude Code
 *   via ANTHROPIC_BASE_URL — runs against local inference with no key.
 *   Node-only. The backend is selected once at startup through the normal
 *   registry precedence; each request clones a fresh session, prompts the
 *   flattened conversation, and replies either as one JSON message or as the
 *   standard SSE event sequence. Loopback binding is asserted, mirroring the
 *   llama-server doctrine: the shim never listens on a routable interface.
 */

import { createServer } from 'node:http'

import { errorMessage } from '@socketsecurity/lib/errors/message'

import { selectBackend } from '../backends/registry.mts'
import { createWithFallback } from '../session.mts'
import { destroySession } from '../model.mts'
import { replyToMessage, toBackendMessages } from './anthropic.mts'
import { estimateTokens } from './protocol.mts'
import { buildSseFrames } from './sse.mts'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { BackendName, OdaiBackend } from '../backends/types.mts'
import type { LanguageModelLike, SessionLike } from '../types.mts'
import type { AnthropicMessagesRequest } from './anthropic.mts'

const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024

const LOOPBACK_HOSTNAMES = new Set(['::1', '127.0.0.1', 'localhost'])

export interface AnthropicShimHandle {
  backendName: BackendName
  close(): Promise<void>
  port: number
  url: string
}

export interface AnthropicShimOptions {
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

export async function handleRequest(
  state: ShimState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const pathname = (request.url ?? '').split('?')[0] ?? ''
  try {
    if (request.method === 'GET' && pathname === '/health') {
      writeJson(response, 200, { status: 'ok' })
      return
    }
    if (request.method !== 'POST') {
      writeError(response, 404, 'not_found_error', `No route for ${pathname}.`)
      return
    }
    const body = await readBody(request)
    if (pathname === '/v1/messages/count_tokens') {
      const parsed = parseMessagesRequest(body)
      const text = toBackendMessages(parsed)
        .map(message => message.content)
        .join('\n')
      writeJson(response, 200, { input_tokens: estimateTokens(text) })
      return
    }
    if (pathname !== '/v1/messages') {
      writeError(response, 404, 'not_found_error', `No route for ${pathname}.`)
      return
    }
    const parsed = parseMessagesRequest(body)
    const messages = toBackendMessages(parsed)
    const inputText = messages.map(message => message.content).join('\n')
    const inputTokens = estimateTokens(inputText)
    state.log(
      `POST /v1/messages model=${parsed.model} turns=${parsed.messages.length} ` +
        `tools=${parsed.tools?.length ?? 0} stream=${parsed.stream === true} ` +
        `input~${inputTokens}tok`,
    )
    const session: SessionLike = await createWithFallback(state.factory, {
      temperature: 0,
      topK: 1,
    })
    let raw: string
    try {
      raw = await session.prompt(messages)
    } finally {
      destroySession(session)
    }
    const message = replyToMessage(raw, parsed, inputTokens)
    state.log(
      `  -> stop_reason=${message.stop_reason} output~` +
        `${message.usage.output_tokens}tok ` +
        (message.content[0]?.type === 'tool_use'
          ? `tool=${(message.content[0] as { name: string }).name}`
          : ''),
    )
    if (parsed.stream === true) {
      response.writeHead(200, {
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream',
      })
      for (const frame of buildSseFrames(message)) {
        response.write(`event: ${frame.event}\ndata: ${frame.data}\n\n`)
      }
      response.end()
      return
    }
    writeJson(response, 200, message)
  } catch (error) {
    if (error instanceof ShimRequestError) {
      writeError(response, error.status, error.errorType, error.message)
      return
    }
    state.log(`anthropic shim request failed: ${errorMessage(error)}`)
    writeError(response, 500, 'api_error', errorMessage(error))
  }
}

export function parseMessagesRequest(body: string): AnthropicMessagesRequest {
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
  const record = parsed as Record<string, unknown>
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

export async function startAnthropicShim(
  options?: AnthropicShimOptions | undefined,
): Promise<AnthropicShimHandle> {
  const opts = { __proto__: null, ...options } as AnthropicShimOptions
  const hostname = opts.hostname ?? '127.0.0.1'
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Anthropic shim hostname "${hostname}" is not loopback. The shim is ` +
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
  const state: ShimState = { factory, log }
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
  log(`anthropic shim listening at ${url} over backend "${backend.name}"`)
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
  status: number,
  errorType: string,
  message: string,
): void {
  writeJson(response, status, {
    error: { message, type: errorType },
    type: 'error',
  })
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
