import { afterEach, expect, it, vi } from 'vitest'
import {
  createPageBoundFactory,
  pageCreateSession,
  pagePrompt,
  pagePromptStreaming,
  waitForModelReady,
} from '../../src/backends/chrome-page.mts'
import type {
  PageLike,
  StreamPayload,
  StreamQueue,
} from '../../src/backends/chrome-page.mts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('passes response constraints to a supporting page session', async () => {
  const prompt = vi.fn().mockResolvedValue('{"allowed":true}')
  vi.stubGlobal('LanguageModel', { create: async () => ({ prompt }) })
  vi.stubGlobal('__odaiSessions', new Map())
  await pageCreateSession({ options: {}, sessionId: 1 })
  const constraint = { type: 'object' }
  expect(
    await pagePrompt({
      messages: [],
      sessionId: 1,
      responseConstraint: constraint,
    }),
  ).toEqual({ ok: true, raw: '{"allowed":true}' })
  expect(prompt).toHaveBeenCalledExactlyOnceWith([], {
    responseConstraint: constraint,
  })
})

it('drains a reader-only stream and emits completion', async () => {
  const chunks: StreamPayload[] = []
  const read = vi
    .fn()
    .mockResolvedValueOnce({ done: false, value: 'fixture chunk' })
    .mockResolvedValueOnce({ done: true, value: undefined })
  vi.stubGlobal(
    '__odaiSessions',
    new Map([
      [1, { promptStreaming: () => ({ getReader: () => ({ read }) }) }],
    ]),
  )
  vi.stubGlobal('__odaiStreamChunk', async (chunk: StreamPayload) => {
    chunks.push(chunk)
  })
  await pagePromptStreaming({ messages: [], sessionId: 1, streamId: 7 })
  expect(chunks).toEqual([
    { chunk: 'fixture chunk', streamId: 7 },
    { done: true, streamId: 7 },
  ])
})

it('tolerates a missing delivery binding on a missing session', async () => {
  vi.stubGlobal('__odaiSessions', new Map())
  vi.stubGlobal('__odaiStreamChunk', undefined)
  await expect(
    pagePromptStreaming({ messages: [], sessionId: 1, streamId: 7 }),
  ).resolves.toBeUndefined()
})

function makePage() {
  const evaluate =
    vi.fn<(fn: unknown, arg?: unknown | undefined) => Promise<unknown>>()
  const page: PageLike = {
    async evaluate<T>(fn: unknown, arg?: unknown | undefined): Promise<T> {
      return (await evaluate(fn, arg)) as T
    },
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
  }
  return { evaluate, page }
}

it('reports clone and prompt failures from the page and absorbs destroy errors', async () => {
  const { page, evaluate } = makePage()
  evaluate.mockResolvedValueOnce({ ok: true, cloneCapable: true })
  const factory = createPageBoundFactory({
    page,
    streams: new Map(),
    close: async () => {},
  })
  const session = await factory.create()
  evaluate.mockResolvedValueOnce({
    ok: false,
    error: { name: 'QuotaExceededError', message: 'fixture quota' },
  })
  await expect(session.clone?.()).rejects.toMatchObject({
    name: 'QuotaExceededError',
  })
  evaluate.mockResolvedValueOnce({
    ok: false,
    error: { name: 'InvalidStateError', message: 'fixture state' },
  })
  await expect(session.prompt([])).rejects.toMatchObject({
    name: 'InvalidStateError',
  })
  evaluate.mockRejectedValueOnce(new Error('page closed'))
  session.destroy?.()
  await Promise.resolve()
})

it('rejects an interrupted page stream and removes its queue', async () => {
  const { page, evaluate } = makePage()
  evaluate.mockResolvedValueOnce({ ok: true, cloneCapable: false })
  const streams = new Map<number, StreamQueue>()
  const session = await createPageBoundFactory({
    page,
    streams,
    close: async () => {},
  }).create()
  evaluate.mockRejectedValueOnce(new Error('fixture page disappeared'))
  const stream = session.promptStreaming([])
  const consume = async () => {
    for await (const chunk of stream) {
      void chunk
    }
  }
  await expect(consume()).rejects.toThrow()
  expect(streams.size).toBe(0)
})

it('absorbs a failed download kick and times out readiness', async () => {
  vi.useFakeTimers()
  const { page, evaluate } = makePage()
  evaluate
    .mockResolvedValueOnce('downloadable')
    .mockRejectedValueOnce(new Error('page closed'))
  const pending = waitForModelReady(page, {
    allowDownload: true,
    readyTimeoutMs: 10,
    userDataDir: '/fixture/profile',
  })
  const assertion = expect(pending).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(10)
  await assertion
})
