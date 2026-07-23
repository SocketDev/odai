/**
 * @file Llama-server backend. Adapts any OpenAI-compatible
 *   `/v1/chat/completions` endpoint — llama.cpp's `llama-server`, ollama,
 *   Foundry Local, and anything speaking the same protocol — to the session
 *   seam. Loopback only: the URL is validated at config time and a
 *   non-loopback host throws, whether it arrives via the option or the env
 *   var. Availability is a live `GET /health` probe. Structured output rides
 *   the existing prefill merge and JSON repair path: the trailing assistant
 *   prefill message goes over the wire as-is and `mergePrefill` reconciles
 *   both echo and continuation replies.
 */

import { errorMessage } from '@socketsecurity/lib/errors/message'

import type { CreateOptions } from '../session.mts'
import type { LanguageModelLike, Message, SessionLike } from '../types.mts'
import type { BackendAvailability, LocaiBackend } from './types.mts'

export const DEFAULT_LLAMA_URL = 'http://127.0.0.1:8080'
export const LOCAI_LLAMA_MODEL_ENV_VAR = 'LOCAI_LLAMA_MODEL'
export const LOCAI_LLAMA_URL_ENV_VAR = 'LOCAI_LLAMA_URL'

const DEFAULT_HEALTH_TIMEOUT_MS = 2000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const ERROR_DETAIL_MAX_LENGTH = 300

/**
 * The only hosts the adapter will speak to. URL hostname parsing lowercases
 * names and keeps IPv6 brackets, so `[::1]` is the bracketed spelling.
 */
const LOOPBACK_HOSTNAMES = new Set(['[::1]', '127.0.0.1', 'localhost'])

export interface LlamaServerBackendOptions {
  /**
   * Env source, `process.env` by default. Injectable for tests.
   */
  env?: Record<string, string | undefined> | undefined
  /**
   * Timeout for the `/health` availability probe.
   */
  healthTimeoutMs?: number | undefined
  /**
   * Model name passed through in the request body. llama-server serves one
   * model and ignores it; ollama and multi-model gateways require it. Falls
   * back to the `LOCAI_LLAMA_MODEL` env var; omitted from the body when unset.
   */
  model?: string | undefined
  /**
   * Timeout for each chat-completion request, streaming included.
   */
  requestTimeoutMs?: number | undefined
  /**
   * Server base URL. Falls back to the `LOCAI_LLAMA_URL` env var, then to
   * `http://127.0.0.1:8080` — llama-server's default bind. Loopback only:
   * a host other than `127.0.0.1`, `::1`, or `localhost` throws at config
   * time, whichever source it came from.
   */
  url?: string | undefined
}

export interface ChatCompletionChunk {
  choices?:
    | Array<{ delta?: { content?: unknown | undefined } | undefined }>
    | undefined
}

export interface ChatCompletionResponse {
  choices?:
    | Array<{ message?: { content?: unknown | undefined } | undefined }>
    | undefined
}

export interface LlamaConfig {
  model: string | undefined
  requestTimeoutMs: number
  url: string
}

export interface SseEvent {
  delta: string | undefined
  done: boolean
}

/**
 * Config-time loopback gate. The doctrine is enforced here, ahead of any
 * network call, so a remote URL can never be probed or prompted — not even
 * through the env var.
 */
export function assertLoopbackUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      `llama-server URL "${url}" is not a valid URL. locai is local-only — ` +
        'no cloud, no remote endpoints, no keys; point ' +
        `${LOCAI_LLAMA_URL_ENV_VAR} at 127.0.0.1, ::1, or localhost.`,
    )
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `llama-server URL "${url}" is not loopback. locai is local-only — ` +
        'no cloud, no remote endpoints, no keys; the llama-server backend ' +
        'only speaks to 127.0.0.1, ::1, or localhost.',
    )
  }
  return url
}

export function buildRequestBody(
  config: LlamaConfig,
  createOptions: CreateOptions,
  messages: Message[],
  requestOptions: { stream: boolean },
): string {
  const combined: Message[] = []
  const hasSystem = messages.some(message => message.role === 'system')
  if (createOptions.initialPrompts !== undefined) {
    combined.push(...createOptions.initialPrompts)
  } else if (createOptions.systemPrompt !== undefined && !hasSystem) {
    combined.push({ content: createOptions.systemPrompt, role: 'system' })
  }
  combined.push(...messages)
  const body: Record<string, unknown> = {
    messages: combined.map(message => ({
      content: message.content,
      role: message.role,
    })),
    stream: requestOptions.stream,
  }
  if (config.model !== undefined) {
    body['model'] = config.model
  }
  if (createOptions.temperature !== undefined) {
    body['temperature'] = createOptions.temperature
  }
  if (createOptions.topK !== undefined) {
    body['top_k'] = createOptions.topK
  }
  return JSON.stringify(body)
}

export function createLlamaServerBackend(
  options?: LlamaServerBackendOptions | undefined,
): LocaiBackend {
  const opts = { __proto__: null, ...options } as LlamaServerBackendOptions
  const env = opts.env ?? (typeof process === 'undefined' ? {} : process.env)
  const url = normalizeUrl(
    assertLoopbackUrl(
      opts.url ?? env[LOCAI_LLAMA_URL_ENV_VAR] ?? DEFAULT_LLAMA_URL,
    ),
  )
  const config: LlamaConfig = {
    model: opts.model ?? env[LOCAI_LLAMA_MODEL_ENV_VAR],
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    url,
  }
  const healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  return {
    async availability(): Promise<BackendAvailability> {
      const endpoint = `${url}/health`
      const remedy =
        `Start llama-server, or point ${LOCAI_LLAMA_URL_ENV_VAR} at an ` +
        'OpenAI-compatible endpoint.'
      let response: Response
      try {
        // socket-lint: allow global-fetch -- this file ships in the browser
        // bundle and httpRequest is Node-only; fetch is the one isomorphic
        // client here.
        response = await fetch(endpoint, {
          signal: AbortSignal.timeout(healthTimeoutMs),
        })
      } catch (error) {
        return {
          available: false,
          reason:
            `llama-server is not reachable at ${endpoint}: ` +
            `${describeRequestError(error, healthTimeoutMs)}. ${remedy}`,
        }
      }
      if (response.ok) {
        return { available: true }
      }
      return {
        available: false,
        reason:
          `llama-server health check at ${endpoint} returned ` +
          `HTTP ${response.status}. ${remedy}`,
      }
    },
    async languageModel(): Promise<LanguageModelLike> {
      return {
        async availability(): Promise<string> {
          return 'available'
        },
        async create(createOptions?: object): Promise<SessionLike> {
          return createLlamaSession(
            config,
            (createOptions ?? {}) as CreateOptions,
          )
        },
      }
    },
    name: 'llama-server',
  }
}

export function createLlamaSession(
  config: LlamaConfig,
  createOptions: CreateOptions,
): SessionLike {
  return {
    async prompt(messages: Message[]): Promise<string> {
      const response = await postChat(
        config,
        buildRequestBody(config, createOptions, messages, { stream: false }),
      )
      const payload = (await response.json()) as ChatCompletionResponse
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new Error(
          `llama-server at ${config.url} returned no ` +
            'choices[0].message.content; expected an OpenAI-compatible ' +
            '/v1/chat/completions response.',
        )
      }
      return content
    },
    promptStreaming(messages: Message[]): AsyncIterable<string> {
      return streamChat(config, createOptions, messages)
    },
  }
}

export function describeRequestError(
  error: unknown,
  timeoutMs: number,
): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `timed out after ${timeoutMs}ms`
  }
  const message = errorMessage(error)
  const cause = (error as { cause?: unknown | undefined }).cause
  if (cause instanceof Error && cause.message !== message) {
    return `${message} (${cause.message})`
  }
  return message
}

export function normalizeUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export function parseSseLine(line: string): SseEvent | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) {
    return undefined
  }
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') {
    return { delta: undefined, done: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  const content = (parsed as ChatCompletionChunk).choices?.[0]?.delta?.content
  return {
    delta: typeof content === 'string' ? content : undefined,
    done: false,
  }
}

export async function postChat(
  config: LlamaConfig,
  body: string,
): Promise<Response> {
  const endpoint = `${config.url}/v1/chat/completions`
  let response: Response
  try {
    // socket-lint: allow global-fetch -- SSE streaming needs incremental
    // response.body reads and this file ships in the browser bundle;
    // httpRequest is Node-only and buffers the whole body.
    response = await fetch(endpoint, {
      body,
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    })
  } catch (error) {
    throw new Error(
      `llama-server request to ${endpoint} failed: ` +
        `${describeRequestError(error, config.requestTimeoutMs)}. ` +
        `Check the server and ${LOCAI_LLAMA_URL_ENV_VAR}.`,
      { cause: error },
    )
  }
  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(
      `llama-server request to ${endpoint} failed: ` +
        `HTTP ${response.status}${detail}`,
    )
  }
  return response
}

export async function readErrorDetail(response: Response): Promise<string> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return ''
  }
  const trimmed = text.trim()
  if (trimmed === '') {
    return ''
  }
  return ` — ${trimmed.slice(0, ERROR_DETAIL_MAX_LENGTH)}`
}

export async function* streamChat(
  config: LlamaConfig,
  createOptions: CreateOptions,
  messages: Message[],
): AsyncGenerator<string> {
  const response = await postChat(
    config,
    buildRequestBody(config, createOptions, messages, { stream: true }),
  )
  const body = response.body
  if (body === null) {
    throw new Error(
      `llama-server streaming request to ${config.url} returned no body.`,
    )
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      buffer += decoder.decode(result.value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        const event = parseSseLine(line)
        if (event?.done) {
          return
        }
        if (event?.delta !== undefined) {
          yield event.delta
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }
    const tail = parseSseLine(buffer)
    if (tail !== undefined && !tail.done && tail.delta !== undefined) {
      yield tail.delta
    }
  } finally {
    reader.releaseLock()
  }
}
