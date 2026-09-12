import { afterEach, describe, expect, it, vi } from 'vitest'
import { withOdaiModel } from '../src/lifecycle.mts'
import { classifyIntent } from '../src/tasks/classify-intent.mts'

const input = {
  candidates: [{ id: 'inspect', description: 'Inspect dependencies' }],
  query: 'inspect',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('withOdaiModel', () => {
  it('probes and prompts the same local backend without identity requests or server shutdown', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: '{"actionId":"inspect"}' } }],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const result = await withOdaiModel(model => classifyIntent(model, input), {
      backend: 'llama-server',
    })
    expect(result).toMatchObject({
      ok: true,
      data: { actionId: 'inspect' },
      model: 'llama-server',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8080/health')
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://127.0.0.1:8080/v1/chat/completions',
    )
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.redirect).toBe('error')
      expect(options?.signal?.aborted).toBe(true)
    }
  })
  it('cancels underlying health transport within the shared deadline', async () => {
    vi.useFakeTimers()
    let transportSignal: AbortSignal | null | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation((_url, options) => {
        transportSignal = options?.signal
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          ),
        )
      }),
    )
    const callback = vi.fn()
    const pending = withOdaiModel(callback, {
      backend: 'llama-server',
      timeoutMs: 100,
    })
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    await vi.advanceTimersByTimeAsync(90)
    await assertion
    expect(transportSignal?.aborted).toBe(true)
    expect(callback).not.toHaveBeenCalled()
  })
  it('cancels inference transport on caller interruption', async () => {
    const controller = new AbortController()
    let promptStarted!: () => void
    const started = new Promise<void>(resolve => {
      promptStarted = resolve
    })
    let requestSignal: AbortSignal | null | undefined
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(''))
        .mockImplementationOnce((_url, options) => {
          requestSignal = options?.signal
          promptStarted()
          return new Promise((_resolve, reject) =>
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            ),
          )
        }),
    )
    const pending = withOdaiModel(model => classifyIntent(model, input), {
      backend: 'llama-server',
      abortSignal: controller.signal,
    })
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    })
    await started
    controller.abort()
    await assertion
    expect(requestSignal?.aborted).toBe(true)
  })
  it.each([
    'simulator',
    'chrome-builtin',
    'apple-fm',
    'windows-phi-silica',
  ] as const)(
    'rejects an incapable backend without probing: %s',
    async backend => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await expect(
        withOdaiModel(async () => true, { backend }),
      ).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )
  it('rejects simulator environment override and remote endpoints without requests', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ODAI_BACKEND', 'simulator')
    await expect(withOdaiModel(async () => true)).rejects.toThrow()
    vi.stubEnv('ODAI_BACKEND', 'llama-server')
    vi.stubEnv('ODAI_LLAMA_URL', 'https://example.com')
    await expect(withOdaiModel(async () => true)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('does not start when cancelled or the budget is invalid', async () => {
    const callback = vi.fn()
    await expect(
      withOdaiModel(callback, { abortSignal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      withOdaiModel(callback, { timeoutMs: Infinity }),
    ).rejects.toThrow(RangeError)
    expect(callback).not.toHaveBeenCalled()
  })
})

it('aborts a pending streaming transport when the operation ends', async () => {
  const controller = new AbortController()
  let begin!: () => void
  const started = new Promise<void>(resolve => {
    begin = resolve
  })
  let signal: AbortSignal | null | undefined
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(''))
      .mockImplementationOnce((_url, options) => {
        signal = options?.signal
        begin()
        return new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal?.reason), {
            once: true,
          }),
        )
      }),
  )
  const pending = withOdaiModel(model => model.promptStreaming('inspect'), {
    backend: 'llama-server',
    abortSignal: controller.signal,
  })
  const assertion = expect(pending).rejects.toMatchObject({
    name: 'AbortError',
  })
  await started
  controller.abort()
  await assertion
  expect(signal?.aborted).toBe(true)
})

it('uses one deadline across a slow probe and inference', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | null | undefined
  let finishHealth!: (response: Response) => void
  const health = new Promise<Response>(resolve => {
    finishHealth = resolve
  })
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(health)
    .mockImplementationOnce((_url, options) => {
      signal = options?.signal
      return new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal?.reason), {
          once: true,
        }),
      )
    })
  vi.stubGlobal('fetch', fetchMock)
  const pending = withOdaiModel(
    model => classifyIntent(model, input, { retries: 2 }),
    { backend: 'llama-server', timeoutMs: 100 },
  )
  const assertion = expect(pending).rejects.toMatchObject({
    name: 'TimeoutError',
  })
  await vi.advanceTimersByTimeAsync(50)
  finishHealth(new Response(''))
  await vi.advanceTimersByTimeAsync(39)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(signal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await assertion
  expect(signal?.aborted).toBe(true)
})

it('exposes the operation signal for cancellable caller-owned work', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')))
  let observed: AbortSignal | undefined
  expect(
    await withOdaiModel(
      async (_model, context) => {
        observed = context.abortSignal
        expect(observed.aborted).toBe(false)
        return 'fixture-result'
      },
      { backend: 'llama-server' },
    ),
  ).toBe('fixture-result')
  expect(observed?.aborted).toBe(true)
})
