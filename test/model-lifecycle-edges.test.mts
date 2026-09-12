import { afterEach, expect, it, vi } from 'vitest'
import {
  createModelFromState,
  createOdaiModel,
  detectSessionModelName,
} from '../src/model.mts'
import type { SessionLike } from '../src/types.mts'

function makeSession(): SessionLike {
  return {
    destroy: vi.fn(),
    prompt: vi.fn().mockResolvedValue('Gemini Nano'),
    promptStreaming: async function* () {
      yield 'fixture'
    },
  }
}

afterEach(() => vi.useRealTimers())

it.each(['structured', 'streaming'])(
  'disposes a late owned clone: %s',
  async mode => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const clone = makeSession()
    let finish!: (session: SessionLike) => void
    const acquisition = new Promise<SessionLike>(resolve => {
      finish = resolve
    })
    const base = makeSession()
    const model = createModelFromState(
      { cloneCapable: false, namespace: 'modern', session: base },
      async () => await acquisition,
      controller.signal,
    )
    const pending =
      mode === 'structured'
        ? model.promptStructured('fixture', {
            prefill: '',
            schema: { parse: value => value === true },
          })
        : model.promptStreaming('fixture')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    finish(clone)
    await acquisition
    await vi.runAllTimersAsync()
    expect(clone.destroy).toHaveBeenCalledTimes(1)
    expect(base.destroy).not.toHaveBeenCalled()
  },
)

it.each(['structured', 'streaming'])(
  'combines caller and owner signals: %s',
  async mode => {
    const owner = new AbortController()
    const caller = new AbortController()
    const base = makeSession()
    const model = createModelFromState(
      { cloneCapable: false, namespace: 'modern', session: base },
      undefined,
      owner.signal,
    )
    caller.abort()
    const pending =
      mode === 'structured'
        ? model.promptStructured('fixture', {
            abortSignal: caller.signal,
            prefill: '',
            schema: { parse: value => value === true },
          })
        : model.promptStreaming('fixture', { abortSignal: caller.signal })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(base.prompt).not.toHaveBeenCalled()
  },
)

it.each([true, false])(
  'handles identity session arrival after timeout, owned=%s',
  async owned => {
    vi.useFakeTimers()
    const base = makeSession()
    const session = owned ? makeSession() : base
    let finish!: (session: SessionLike) => void
    const acquisition = new Promise<SessionLike>(resolve => {
      finish = resolve
    })
    const pending = detectSessionModelName(
      { cloneCapable: false, namespace: 'modern', session: base },
      async () => await acquisition,
      10,
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toBeUndefined()
    finish(session)
    await acquisition
    await vi.runAllTimersAsync()
    expect(session.destroy).toHaveBeenCalledTimes(owned ? 1 : 0)
    expect(session.prompt).not.toHaveBeenCalled()
  },
)

it('ignores identity completion after its timeout', async () => {
  vi.useFakeTimers()
  const base = makeSession()
  const probe = makeSession()
  let finish!: (text: string) => void
  const response = new Promise<string>(resolve => {
    finish = resolve
  })
  probe.prompt = vi.fn().mockReturnValue(response)
  const pending = detectSessionModelName(
    { cloneCapable: false, namespace: 'modern', session: base },
    async () => probe,
    10,
  )
  await vi.advanceTimersByTimeAsync(10)
  expect(await pending).toBeUndefined()
  finish('Gemini Nano')
  await response
  expect(probe.destroy).toHaveBeenCalledTimes(1)
})

it('reports absent identity when session creation fails', async () => {
  const base = makeSession()
  const result = await detectSessionModelName(
    { cloneCapable: false, namespace: 'modern', session: base },
    async () => {
      throw new Error('fixture unavailable')
    },
  )
  expect(result).toBeUndefined()
  expect(base.destroy).not.toHaveBeenCalled()
})

it('disposes the model base if cancellation interrupts identity detection', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const base = makeSession()
  const probe = makeSession()
  probe.prompt = vi.fn().mockImplementation(async () => {
    controller.abort()
    return 'Gemini Nano'
  })
  const create = vi
    .fn()
    .mockResolvedValueOnce(base)
    .mockResolvedValueOnce(probe)
  await expect(
    createOdaiModel({
      abortSignal: controller.signal,
      backend: {
        name: 'simulator',
        availability: async () => ({ available: true }),
        languageModel: async () => ({
          availability: async () => 'available',
          create,
        }),
      },
    }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(base.destroy).toHaveBeenCalledTimes(1)
  await vi.runAllTimersAsync()
})
