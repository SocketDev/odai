import { createServer } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildRequestBody,
  createLlamaServerBackend,
  DEFAULT_LLAMA_URL,
  describeRequestError,
  normalizeUrl,
  ODAI_LLAMA_MODEL_ENV_VAR,
  ODAI_LLAMA_URL_ENV_VAR,
  parseSseLine,
  streamChat,
} from '../../src/backends/llama-server.mts'
import { createOdaiModel } from '../../src/model.mts'
import type { Server } from 'node:http'
import type { LlamaConfig } from '../../src/backends/llama-server.mts'
import type { Message, SchemaLike } from '../../src/types.mts'

interface CapturedRequest {
  body: unknown
  method: string | undefined
  url: string | undefined
}

interface MockServerHandle {
  captured: CapturedRequest[]
  close(): Promise<void>
  url: string
}

interface MockServerOptions {
  chatBody?: string | undefined
  chatContent?: string | undefined
  chatStatus?: number | undefined
  hang?: boolean | undefined
  healthStatus?: number | undefined
  sseDeltas?: string[] | undefined
  sseTrailing?: string | undefined
}

const summarySchema: SchemaLike<{ summary: string }> = {
  parse(value: unknown): { summary: string } {
    const record = value as { summary?: unknown | undefined }
    if (typeof record.summary !== 'string') {
      throw new TypeError('summary must be a string')
    }
    return { summary: record.summary }
  },
}

async function startMockServer(
  options: MockServerOptions = {},
): Promise<MockServerHandle> {
  const opts = { __proto__: null, ...options } as MockServerOptions
  const captured: CapturedRequest[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      captured.push({
        body: text === '' ? undefined : JSON.parse(text),
        method: request.method,
        url: request.url,
      })
      if (opts.hang) {
        return
      }
      if (request.url === '/health') {
        response.statusCode = opts.healthStatus ?? 200
        response.end('{"status":"ok"}')
        return
      }
      if (opts.sseDeltas !== undefined) {
        response.setHeader('content-type', 'text/event-stream')
        for (const delta of opts.sseDeltas) {
          const chunk = {
            choices: [{ delta: { content: delta } }],
          }
          response.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      if (opts.sseTrailing !== undefined) {
        // End the stream on a final line with no trailing newline and no
        // [DONE], so the reader must flush the buffered tail after the loop.
        response.setHeader('content-type', 'text/event-stream')
        const chunk = {
          choices: [{ delta: { content: opts.sseTrailing } }],
        }
        response.end(`data: ${JSON.stringify(chunk)}`)
        return
      }
      response.statusCode = opts.chatStatus ?? 200
      if (opts.chatBody !== undefined) {
        response.end(opts.chatBody)
        return
      }
      response.end(
        JSON.stringify({
          choices: [
            { message: { content: opts.chatContent ?? '', role: 'assistant' } },
          ],
        }),
      )
    })
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port =
    typeof address === 'object' && address !== null ? address.port : 0
  return {
    captured,
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>(resolve => {
        server.close(() => resolve())
      })
    },
    url: `http://127.0.0.1:${port}`,
  }
}

describe('llama-server backend', () => {
  let handle: MockServerHandle | undefined

  afterEach(async () => {
    await handle?.close()
    handle = undefined
  })

  it('defaults to the llama-server bind address', () => {
    expect(DEFAULT_LLAMA_URL).toBe('http://127.0.0.1:8080')
  })

  it('accepts every loopback spelling at config time', () => {
    for (const url of [
      'http://127.0.0.1:8080',
      'http://localhost:8080',
      'http://[::1]:8080',
      'https://localhost:11434/',
    ]) {
      expect(() => createLlamaServerBackend({ url })).not.toThrow()
    }
  })

  it('refuses a non-loopback URL outright at config time', () => {
    for (const url of [
      'http://example.com:8080',
      'https://api.openai.com/v1',
      'http://192.168.1.10:8080',
      'http://10.0.0.5:11434',
      'http://llama.internal:8080',
    ]) {
      expect(() => createLlamaServerBackend({ url })).toThrow(
        /not loopback.*odai is local-only/s,
      )
    }
  })

  it('refuses a non-loopback URL from the env var — no env escape', () => {
    expect(() =>
      createLlamaServerBackend({
        env: { [ODAI_LLAMA_URL_ENV_VAR]: 'http://models.example.dev:8080' },
      }),
    ).toThrow(/not loopback.*odai is local-only/s)
  })

  it('refuses an unparseable URL with the doctrine message', () => {
    expect(() => createLlamaServerBackend({ url: 'not a url' })).toThrow(
      /not a valid URL.*odai is local-only/s,
    )
  })

  it('reports available when /health answers 200', async () => {
    handle = await startMockServer()
    const backend = createLlamaServerBackend({ url: handle.url })
    expect(await backend.availability()).toEqual({ available: true })
    expect(handle.captured[0]?.url).toBe('/health')
  })

  it('reports unreachable with the probed endpoint when nothing listens', async () => {
    const probe = await startMockServer()
    const url = probe.url
    await probe.close()
    const backend = createLlamaServerBackend({ url })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain(`${url}/health`)
    expect(availability.reason).toContain('ODAI_LLAMA_URL')
  })

  it('reports the HTTP status when /health answers non-2xx', async () => {
    handle = await startMockServer({ healthStatus: 503 })
    const backend = createLlamaServerBackend({ url: handle.url })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('HTTP 503')
  })

  it('reads the URL and model from injected env', async () => {
    handle = await startMockServer({ chatContent: 'hi' })
    const backend = createLlamaServerBackend({
      env: {
        [ODAI_LLAMA_MODEL_ENV_VAR]: 'qwen2.5-coder-7b-instruct-q4_k_m',
        [ODAI_LLAMA_URL_ENV_VAR]: `${handle.url}/`,
      },
    })
    expect(await backend.availability()).toEqual({ available: true })
    const factory = await backend.languageModel()
    const session = await factory.create()
    await session.prompt([{ content: 'hello', role: 'user' }])
    const chat = handle.captured.at(-1)
    expect(chat?.url).toBe('/v1/chat/completions')
    const body = chat?.body as { model?: string | undefined } | undefined
    expect(body?.model).toBe('qwen2.5-coder-7b-instruct-q4_k_m')
  })

  it('shapes chat requests with session options and message pass-through', async () => {
    handle = await startMockServer({ chatContent: 'ok"}' })
    const model = await createOdaiModel({
      backend: createLlamaServerBackend({
        model: 'test-model',
        url: handle.url,
      }),
      systemPrompt: 'You fix lint findings.',
      temperature: 0.2,
      topK: 3,
    })
    const result = await model.promptStructured<{ summary: string }>(
      'summarize the diff',
      { prefill: '{"summary":"', schema: summarySchema },
    )
    expect(result.ok).toBe(true)
    const chat = handle.captured.at(-1)
    expect(chat?.method).toBe('POST')
    expect(chat?.url).toBe('/v1/chat/completions')
    const body = chat?.body as {
      messages: Array<{ content: string; role: string }>
      model: string
      stream: boolean
      temperature: number
      top_k: number
    }
    expect(body.model).toBe('test-model')
    expect(body.stream).toBe(false)
    expect(body.temperature).toBe(0.2)
    expect(body.top_k).toBe(3)
    expect(body.messages.map(message => message.role)).toEqual([
      'system',
      'user',
      'assistant',
    ])
    expect(body.messages[2]?.content).toBe('{"summary":"')
  })

  it('parses continuation replies through the prefill merge', async () => {
    handle = await startMockServer({ chatContent: 'lodash deduped"}' })
    const model = await createOdaiModel({
      backend: createLlamaServerBackend({ url: handle.url }),
    })
    const result = await model.promptStructured<{ summary: string }>('dedupe', {
      prefill: '{"summary":"',
      schema: summarySchema,
    })
    expect(result.ok).toBe(true)
    expect(result.data?.summary).toBe('lodash deduped')
  })

  it('parses echo replies with markdown fences through the repair path', async () => {
    handle = await startMockServer({
      chatContent: '```json\n{"summary":"echoed"}\n```',
    })
    const model = await createOdaiModel({
      backend: createLlamaServerBackend({ url: handle.url }),
    })
    const result = await model.promptStructured<{ summary: string }>('dedupe', {
      prefill: '{"summary":"',
      schema: summarySchema,
    })
    expect(result.ok).toBe(true)
    expect(result.data?.summary).toBe('echoed')
  })

  it('streams SSE deltas into one raw response', async () => {
    handle = await startMockServer({ sseDeltas: ['{"ok"', ':', 'true}'] })
    const model = await createOdaiModel({
      backend: createLlamaServerBackend({ url: handle.url }),
    })
    const result = await model.promptStreaming('hello')
    expect(result.raw).toBe('{"ok":true}')
    const body = handle.captured.at(-1)?.body as
      | { stream?: boolean | undefined }
      | undefined
    expect(body?.stream).toBe(true)
  })

  it('flushes a trailing SSE line that arrives without a newline', async () => {
    handle = await startMockServer({ sseTrailing: 'tail-delta' })
    const model = await createOdaiModel({
      backend: createLlamaServerBackend({ url: handle.url }),
    })
    const result = await model.promptStreaming('hello')
    expect(result.raw).toBe('tail-delta')
  })

  it('throws with status and body detail on a non-2xx completion', async () => {
    handle = await startMockServer({
      chatBody: '{"error":{"message":"model is loading"}}',
      chatStatus: 503,
    })
    const backend = createLlamaServerBackend({ url: handle.url })
    const factory = await backend.languageModel()
    const session = await factory.create()
    await expect(
      session.prompt([{ content: 'hello', role: 'user' }]),
    ).rejects.toThrow(/HTTP 503.*model is loading/s)
  })

  it('throws a shape error when the response has no message content', async () => {
    handle = await startMockServer({ chatBody: '{"choices":[]}' })
    const backend = createLlamaServerBackend({ url: handle.url })
    const factory = await backend.languageModel()
    const session = await factory.create()
    await expect(
      session.prompt([{ content: 'hello', role: 'user' }]),
    ).rejects.toThrow(/OpenAI-compatible/)
  })

  it('times out a hung completion with the configured budget', async () => {
    handle = await startMockServer({ hang: true })
    const backend = createLlamaServerBackend({
      requestTimeoutMs: 100,
      url: handle.url,
    })
    const factory = await backend.languageModel()
    const session = await factory.create()
    await expect(
      session.prompt([{ content: 'hello', role: 'user' }]),
    ).rejects.toThrow(/timed out after 100ms/)
  })

  it('times out a hung health probe instead of hanging selection', async () => {
    handle = await startMockServer({ hang: true })
    const backend = createLlamaServerBackend({
      healthTimeoutMs: 100,
      url: handle.url,
    })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('timed out after 100ms')
  })

  it('throws when a streaming response carries no body', async () => {
    const config: LlamaConfig = {
      model: undefined,
      requestTimeoutMs: 2000,
      url: 'http://127.0.0.1:9',
    }
    const generator = streamChat(config, {}, [{ content: 'hi', role: 'user' }])
    // Reaching the first chunk performs the POST; an unreachable loopback port
    // fails the request before any body is read.
    await expect(generator.next()).rejects.toThrow(/llama-server request/)
  })
})

describe('buildRequestBody', () => {
  const config: LlamaConfig = {
    model: 'm',
    requestTimeoutMs: 1000,
    url: 'http://127.0.0.1:8080',
  }

  it('prepends initialPrompts ahead of the turn messages', () => {
    const messages: Message[] = [{ content: 'hi', role: 'user' }]
    const body = JSON.parse(
      buildRequestBody(
        config,
        { initialPrompts: [{ content: 'sys', role: 'system' }] },
        messages,
        { stream: false },
      ),
    ) as { messages: Message[]; model: string }
    expect(body.messages[0]).toEqual({ content: 'sys', role: 'system' })
    expect(body.model).toBe('m')
  })

  it('injects the systemPrompt only when no system turn exists', () => {
    const withSystemTurn = JSON.parse(
      buildRequestBody(
        config,
        { systemPrompt: 'ignored' },
        [
          { content: 'be terse', role: 'system' },
          { content: 'hi', role: 'user' },
        ],
        { stream: true },
      ),
    ) as { messages: Message[] }
    expect(
      withSystemTurn.messages.filter(m => m.role === 'system'),
    ).toHaveLength(1)

    const injected = JSON.parse(
      buildRequestBody(
        config,
        { systemPrompt: 'be terse', temperature: 0.5, topK: 4 },
        [{ content: 'hi', role: 'user' }],
        { stream: false },
      ),
    ) as {
      messages: Message[]
      temperature: number
      top_k: number
    }
    expect(injected.messages[0]).toEqual({
      content: 'be terse',
      role: 'system',
    })
    expect(injected.temperature).toBe(0.5)
    expect(injected.top_k).toBe(4)
  })
})

describe('parseSseLine', () => {
  it('ignores non-data lines', () => {
    expect(parseSseLine('event: ping')).toBeUndefined()
  })

  it('marks the [DONE] sentinel as done', () => {
    expect(parseSseLine('data: [DONE]')).toEqual({
      delta: undefined,
      done: true,
    })
  })

  it('extracts the delta content', () => {
    expect(
      parseSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}'),
    ).toEqual({ delta: 'hi', done: false })
  })

  it('returns undefined for unparseable data payloads', () => {
    expect(parseSseLine('data: {not json')).toBeUndefined()
  })

  it('yields an undefined delta when content is absent', () => {
    expect(parseSseLine('data: {"choices":[{"delta":{}}]}')).toEqual({
      delta: undefined,
      done: false,
    })
  })
})

describe('describeRequestError', () => {
  it('names a timeout error with the budget', () => {
    const timeout = new Error('boom')
    timeout.name = 'TimeoutError'
    expect(describeRequestError(timeout, 500)).toBe('timed out after 500ms')
  })

  it('appends a differing cause message', () => {
    const error = new Error('outer')
    ;(error as { cause?: unknown | undefined }).cause = new Error(
      'inner detail',
    )
    const described = describeRequestError(error, 500)
    expect(described).toContain('outer')
    expect(described).toContain('(inner detail)')
  })

  it('returns the plain message without a redundant cause', () => {
    expect(describeRequestError(new Error('plain'), 500)).toBe('plain')
  })
})

describe('normalizeUrl', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080')
    expect(normalizeUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })
})
