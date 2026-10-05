/**
 * @file Node client for Kev's local TypeSafe System One service.
 *   Kev returns typed answers and calibrated distributions, so it is not a
 *   text-generation backend in odai's LanguageModel chain.
 */

import { errorMessage } from '@socketsecurity/lib-stable/errors/message'

import {
  parseKevResponse,
  parseModelCards,
  validateDecisionRequest,
} from './kev/response.mts'

export const DEFAULT_KEV_URL = 'http://127.0.0.1:8009'
export const DEFAULT_KEV_RUN =
  'runs/kev-accuracy-75-20260928/calibration-C-lr2e6'
export const ODAI_KEV_URL_ENV_VAR = 'ODAI_KEV_URL'

const DEFAULT_MODEL = 'kev-latest'
const DEFAULT_TIMEOUT_MS = 120_000

export type KevJsonValue =
  | string
  | number
  | boolean
  | null
  | KevJsonValue[]
  | { [key: string]: KevJsonValue }

export interface KevNoulQuestion {
  criteria?: Record<string, KevJsonValue> | undefined
  instructions?: KevJsonValue | undefined
  type: 'noul'
}

export interface KevChoiceQuestion {
  criteria: Record<string, KevJsonValue>
  instructions?: KevJsonValue | undefined
  type: 'choice'
}

export interface KevScoreQuestion {
  criteria: KevJsonValue[]
  instructions?: KevJsonValue | undefined
  type: 'score'
}

export type KevQuestion = KevNoulQuestion | KevChoiceQuestion | KevScoreQuestion

export interface KevDecisionRequest {
  model?: string | undefined
  questions: Record<string, KevQuestion>
  state: KevJsonValue
}

export interface KevNoulDecision {
  noul: number
  type: 'noul'
}

export interface KevChoiceDecision {
  choice: string
  confidence: number
  probabilities: Record<string, number>
  type: 'choice'
}

export interface KevScoreDecision {
  confidence: number
  legend: Record<string, string>
  probabilities: Record<string, number>
  score: number
  type: 'score'
}

export type KevDecision = KevNoulDecision | KevChoiceDecision | KevScoreDecision

export interface KevModelCard {
  base: string
  backend: string
  device: string
  dtype: string
  name: string
  run: string
  temperature: number
}

export interface KevResponse {
  answers: Record<string, KevDecision>
  model: string
  truncated: boolean
}

export interface KevClientOptions {
  apiKey?: string | undefined
  env?: Record<string, string | undefined> | undefined
  expectedRun?: string | undefined
  fetch?: typeof fetch | undefined
  model?: string | undefined
  requestTimeoutMs?: number | undefined
  url?: string | undefined
}

export interface KevRequestOptions {
  abortSignal?: AbortSignal | undefined
}

export interface KevClient {
  decide(
    request: KevDecisionRequest,
    options?: KevRequestOptions | undefined,
  ): Promise<KevResponse>
  models(options?: KevRequestOptions | undefined): Promise<KevModelCard[]>
}

/**
 * Validate and normalize a local Kev server URL before any network request.
 */
export function assertKevLoopbackUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      `Kev URL is invalid. Where: ${ODAI_KEV_URL_ENV_VAR}. Saw a malformed URL; wanted a loopback HTTP(S) URL. Fix: use http://127.0.0.1:8009 or another local address.`,
    )
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      `Kev URL is unsafe. Where: ${ODAI_KEV_URL_ENV_VAR}. Saw a non-HTTP URL, embedded credentials, query, or fragment; wanted a clean loopback URL. Fix: pass the API key through client options and use HTTP(S).`,
    )
  }
  const hostname = parsed.hostname.toLowerCase()
  if (
    hostname !== '127.0.0.1' &&
    hostname !== 'localhost' &&
    hostname !== '[::1]' &&
    !hostname.endsWith('.localhost')
  ) {
    throw new Error(
      `Kev URL is not local. Where: ${ODAI_KEV_URL_ENV_VAR}. Saw ${hostname}; wanted a loopback host. Fix: bind Kev to 127.0.0.1 or localhost.`,
    )
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/$/, '')
}

/**
 * Create a loopback-only client for Kev's `/v1/systemone` API.
 */
export function createKevClient(
  options?: KevClientOptions | undefined,
): KevClient {
  const opts = { __proto__: null, ...options } as KevClientOptions
  const env = opts.env ?? (typeof process === 'undefined' ? {} : process.env)
  const baseUrl = assertKevLoopbackUrl(
    opts.url ?? env[ODAI_KEV_URL_ENV_VAR] ?? DEFAULT_KEV_URL,
  )
  const apiKey = opts.apiKey ?? env['KEV_API_KEY']
  const model = opts.model ?? DEFAULT_MODEL
  const expectedRun = opts.expectedRun ?? DEFAULT_KEV_RUN
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetcher = opts.fetch ?? fetch

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Kev request timeout must be a positive integer.')
  }
  if (model.trim() === '') {
    throw new TypeError('Kev model name must not be empty.')
  }
  if (expectedRun.trim() === '') {
    throw new TypeError('Kev expected run must not be empty.')
  }

  async function models(
    requestOptions?: KevRequestOptions | undefined,
  ): Promise<KevModelCard[]> {
    const payload = await request(
      'GET',
      '/v1/models',
      undefined,
      requestOptions,
    )
    const cards = parseModelCards(payload)
    if (!cards.some(card => card.run === expectedRun)) {
      throw new Error(
        `Kev checkpoint identity does not match. Where: GET /v1/models. Saw ${cards.map(card => card.run).join(', ') || 'no model cards'}; wanted ${expectedRun}. Fix: start Kev with the required explicit checkpoint or configure expectedRun.`,
      )
    }
    return cards
  }

  async function decide(
    decisionRequest: KevDecisionRequest,
    requestOptions?: KevRequestOptions | undefined,
  ): Promise<KevResponse> {
    validateDecisionRequest(decisionRequest)
    await models(requestOptions)
    const requestedModel = decisionRequest.model ?? model
    const payload = await request(
      'POST',
      '/v1/systemone',
      { ...decisionRequest, model: requestedModel },
      requestOptions,
    )
    const response = parseKevResponse(payload, decisionRequest.questions)
    if (response.model !== requestedModel) {
      throw new Error(
        `Kev model response does not match the request. Where: POST /v1/systemone. Saw ${response.model}; wanted ${requestedModel}. Fix: check the local Kev server version.`,
      )
    }
    if (response.truncated) {
      throw new Error(
        'Kev truncated the input state. Where: POST /v1/systemone. Saw a partial state; wanted the full state. Fix: reduce the state or start Kev with truncation disabled.',
      )
    }
    return response
  }

  return { decide, models }

  async function request(
    method: 'GET' | 'POST',
    pathname: string,
    body: object | undefined,
    requestOptions?: KevRequestOptions | undefined,
  ): Promise<unknown> {
    const headers = new Headers({ accept: 'application/json' })
    if (apiKey !== undefined && apiKey !== '') {
      headers.set('authorization', `Bearer ${apiKey}`)
    }
    if (body !== undefined) {
      headers.set('content-type', 'application/json')
    }
    let response: Response
    try {
      response = await fetcher(`${baseUrl}${pathname}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        method,
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(timeoutMs),
          ...(requestOptions?.abortSignal === undefined
            ? []
            : [requestOptions.abortSignal]),
        ]),
      })
    } catch (error) {
      if (requestOptions?.abortSignal?.aborted) {
        throw requestOptions.abortSignal.reason
      }
      throw new Error(
        `Kev request failed. Where: ${method} ${pathname}. Saw ${errorMessage(error)}; wanted a response from ${baseUrl}. Fix: start the local Kev server or check its port.`,
        { cause: error },
      )
    }
    if (!response.ok) {
      throw new Error(
        `Kev request was rejected. Where: ${method} ${pathname}. Saw HTTP ${response.status}; wanted a successful response. Fix: check the request, model context limit, and KEV_API_KEY configuration.`,
      )
    }
    try {
      return await response.json()
    } catch (error) {
      throw new Error(
        `Kev returned invalid JSON. Where: ${method} ${pathname}. Saw ${errorMessage(error)}; wanted a JSON response. Fix: check the local Kev server version and logs.`,
        { cause: error },
      )
    }
  }
}

export { parseKevResponse, parseModelCards, validateDecisionRequest }
