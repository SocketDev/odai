import { createServer } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertKevLoopbackUrl,
  createKevClient,
  DEFAULT_KEV_RUN,
  ODAI_KEV_URL_ENV_VAR,
  parseKevResponse,
  parseModelCards,
  validateDecisionRequest,
} from '../src/kev.mts'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { KevDecisionRequest } from '../src/kev.mts'

interface CapturedRequest {
  authorization: string | undefined
  body: unknown
  method: string | undefined
  url: string | undefined
}

interface FakeKevOptions {
  modelsStatus?: number | undefined
  response?: unknown | undefined
  responseStatus?: number | undefined
  responseText?: string | undefined
  hang?: boolean | undefined
}

interface FakeKev {
  captured: CapturedRequest[]
  close(): Promise<void>
  url: string
}

const request: KevDecisionRequest = {
  questions: {
    escalation: { type: 'noul', instructions: 'Does this need a person?' },
    route: {
      criteria: { billing: 'Payment issues', shipping: 'Delivery issues' },
      type: 'choice',
    },
    severity: { criteria: ['low', 'medium', 'high'], type: 'score' },
  },
  state: 'A package arrived late and I was charged twice.',
}

const answers = {
  escalation: { noul: 0.875, type: 'noul' },
  route: {
    choice: 'billing',
    confidence: 0.5,
    probabilities: { billing: 0.75, shipping: 0.25 },
    type: 'choice',
  },
  severity: {
    confidence: 0.6,
    legend: { '0': 'low', '1': 'medium', '2': 'high' },
    probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 },
    score: 1.1,
    type: 'score',
  },
}

const modelCard = {
  backend: 'mlx',
  base: 'Qwen/Qwen3.5-4B-Base',
  device: 'mps',
  dtype: 'bf16',
  name: 'kev-latest',
  run: DEFAULT_KEV_RUN,
  temperature: 1.32,
}

const servers: FakeKev[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close()
  }
})

describe('Kev typed client', () => {
  it('allows local URLs and rejects remote hosts, credentials, and query strings', () => {
    expect(assertKevLoopbackUrl('http://127.0.0.1:8009')).toBe(
      'http://127.0.0.1:8009',
    )
    expect(assertKevLoopbackUrl('http://model.localhost:8009/')).toBe(
      'http://model.localhost:8009',
    )
    expect(() => assertKevLoopbackUrl('https://example.com')).toThrow()
    expect(() =>
      assertKevLoopbackUrl('http://user:pass@localhost:8009'),
    ).toThrow()
    expect(() =>
      assertKevLoopbackUrl('http://localhost:8009?token=x'),
    ).toThrow()
    expect(() => assertKevLoopbackUrl('file:///tmp/kev')).toThrow()
  })

  it('sends typed questions and parses all Kev answer types', async () => {
    const fake = await startFakeKev()
    const client = createKevClient({
      apiKey: 'sktsec_abc123abc123abc123abc123',
      url: fake.url,
    })

    const cards = await client.models()
    const result = await client.decide(request)

    expect(cards).toEqual([modelCard])
    expect(result).toEqual({ answers, model: 'kev-latest', truncated: false })
    expect(fake.captured.map(entry => [entry.method, entry.url])).toEqual([
      ['GET', '/v1/models'],
      ['GET', '/v1/models'],
      ['POST', '/v1/systemone'],
    ])
    expect(
      fake.captured.every(
        entry =>
          entry.authorization === 'Bearer sktsec_abc123abc123abc123abc123',
      ),
    ).toBe(true)
    expect(fake.captured[2]?.body).toEqual({ ...request, model: 'kev-latest' })
  })

  it('rejects a different served checkpoint before inference', async () => {
    const fake = await startFakeKev()
    const client = createKevClient({
      expectedRun: 'runs/custom-model',
      url: fake.url,
    })

    await expect(client.decide(request)).rejects.toThrow()
    expect(fake.captured).toHaveLength(1)
    expect(fake.captured[0]?.url).toBe('/v1/models')
  })

  it('rejects a truncated state instead of returning a partial decision', async () => {
    const fake = await startFakeKev({
      response: { answers, model: 'kev-latest', truncated: true },
    })
    const client = createKevClient({ url: fake.url })

    await expect(client.decide(request)).rejects.toThrow()
  })

  it('rejects malformed JSON, HTTP errors, and malformed model cards', async () => {
    const invalidJson = await startFakeKev({ responseText: '{' })
    await expect(
      createKevClient({ url: invalidJson.url }).decide(request),
    ).rejects.toThrow()

    const rejected = await startFakeKev({ responseStatus: 422 })
    await expect(
      createKevClient({ url: rejected.url }).decide(request),
    ).rejects.toThrow()

    expect(() =>
      parseModelCards({ models: [{ name: 'kev-latest' }] }),
    ).toThrow()
  })

  it('propagates cancellation and reports a missing local server', async () => {
    const fake = await startFakeKev({ hang: true })
    const controller = new AbortController()
    const client = createKevClient({ requestTimeoutMs: 10_000, url: fake.url })
    const pending = client.decide(request, { abortSignal: controller.signal })
    controller.abort(new DOMException('Cancelled by caller', 'AbortError'))
    await expect(pending).rejects.toThrow()

    await expect(
      createKevClient({ url: 'http://127.0.0.1:1' }).models(),
    ).rejects.toThrow()
  })

  it('reads URL and API key from the supplied environment', async () => {
    const fake = await startFakeKev()
    const client = createKevClient({
      env: {
        [ODAI_KEV_URL_ENV_VAR]: fake.url,
        KEV_API_KEY: 'sktsec_abc123abc123abc123abc123',
      },
    })

    await client.models()
    expect(fake.captured[0]?.authorization).toBe(
      'Bearer sktsec_abc123abc123abc123abc123',
    )
  })
})

describe('Kev request and response validation', () => {
  it('rejects empty or oversized question shapes', () => {
    expect(() =>
      validateDecisionRequest({ questions: {}, state: 'x' }),
    ).toThrow()
    expect(() =>
      validateDecisionRequest({
        questions: {
          route: { criteria: {}, type: 'choice' },
        },
        state: 'x',
      }),
    ).toThrow()
    expect(() =>
      validateDecisionRequest({
        questions: {
          route: {
            criteria: Object.fromEntries(
              Array.from({ length: 256 }, (_value, index) => [
                String(index),
                '',
              ]),
            ),
            type: 'choice',
          },
        },
        state: 'x',
      }),
    ).toThrow()
  })

  it('rejects mismatched questions, answers, option keys, and invalid probabilities', () => {
    expect(() => parseKevResponse({}, request.questions)).toThrow()
    expect(() =>
      parseKevResponse({ answers: {}, model: 'kev-latest' }, request.questions),
    ).toThrow()
    expect(() =>
      parseKevResponse(
        {
          answers: {
            ...answers,
            route: { ...answers.route, choice: 'unknown' },
          },
          model: 'kev-latest',
        },
        request.questions,
      ),
    ).toThrow()
    expect(() =>
      parseKevResponse(
        {
          answers: {
            ...answers,
            severity: {
              ...answers.severity,
              probabilities: { '0': 0.1, '1': 0.2, '2': 0.2 },
            },
          },
          model: 'kev-latest',
        },
        request.questions,
      ),
    ).toThrow()
    expect(() =>
      parseKevResponse(
        {
          answers: { ...answers, escalation: { noul: 1.1, type: 'noul' } },
          model: 'kev-latest',
        },
        request.questions,
      ),
    ).toThrow()
  })
})

async function startFakeKev(options: FakeKevOptions = {}): Promise<FakeKev> {
  const opts = { __proto__: null, ...options } as FakeKevOptions
  const captured: CapturedRequest[] = []
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      captured.push({
        authorization: incoming.headers.authorization,
        body: raw === '' ? undefined : JSON.parse(raw),
        method: incoming.method,
        url: incoming.url,
      })
      if (opts.hang) {
        return
      }
      if (incoming.url === '/v1/models') {
        outgoing.statusCode = opts.modelsStatus ?? 200
        outgoing.end(JSON.stringify({ models: [modelCard] }))
        return
      }
      outgoing.statusCode = opts.responseStatus ?? 200
      outgoing.end(
        opts.responseText ??
          JSON.stringify(
            opts.response ?? {
              answers,
              model: 'kev-latest',
              truncated: false,
            },
          ),
      )
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const fake = {
    captured,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close(error => (error ? reject(error) : resolve()))
      }),
    url: `http://127.0.0.1:${address.port}`,
  }
  servers.push(fake)
  return fake
}
