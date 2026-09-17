import { afterEach, expect, it, vi } from 'vitest'
import {
  createModelFromState,
  createOdaiModel,
  detectSessionModelName,
} from '../src/model.mts'
import type { SessionLike } from '../src/types.mts'

function makeSessionFixture() {
  const destroy = vi.fn()
  const prompt = vi.fn().mockResolvedValue('Gemini Nano')
  const session: SessionLike = {
    destroy,
    prompt,
    promptStreaming: async function* () {
      yield 'fixture'
    },
  }
  return { destroy, prompt, session }
}

afterEach(() => vi.useRealTimers())

it.each(['structured', 'streaming'])(
  'disposes a late owned clone: %s',
  async mode => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const cloneFixture = makeSessionFixture()
    let finish!: (session: SessionLike) => void
    const acquisition = new Promise<SessionLike>(resolve => {
      finish = resolve
    })
    const baseFixture = makeSessionFixture()
    const model = createModelFromState(
      {
        cloneCapable: false,
        namespace: 'modern',
        session: baseFixture.session,
      },
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
    finish(cloneFixture.session)
    await acquisition
    await vi.runAllTimersAsync()
    expect(cloneFixture.destroy).toHaveBeenCalledTimes(1)
    expect(baseFixture.destroy).not.toHaveBeenCalled()
  },
)

it.each(['structured', 'streaming'])(
  'combines caller and owner signals: %s',
  async mode => {
    const owner = new AbortController()
    const caller = new AbortController()
    const baseFixture = makeSessionFixture()
    const model = createModelFromState(
      {
        cloneCapable: false,
        namespace: 'modern',
        session: baseFixture.session,
      },
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
    expect(baseFixture.prompt).not.toHaveBeenCalled()
  },
)

it.each([true, false])(
  'handles identity session arrival after timeout, owned=%s',
  async owned => {
    vi.useFakeTimers()
    const baseFixture = makeSessionFixture()
    const ownedFixture = makeSessionFixture()
    const sessionFixture = owned ? ownedFixture : baseFixture
    let finish!: (session: SessionLike) => void
    const acquisition = new Promise<SessionLike>(resolve => {
      finish = resolve
    })
    const pending = detectSessionModelName(
      {
        cloneCapable: false,
        namespace: 'modern',
        session: baseFixture.session,
      },
      async () => await acquisition,
      10,
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toBeUndefined()
    finish(sessionFixture.session)
    await acquisition
    await vi.runAllTimersAsync()
    expect(sessionFixture.destroy).toHaveBeenCalledTimes(owned ? 1 : 0)
    expect(sessionFixture.prompt).not.toHaveBeenCalled()
  },
)

it('ignores identity completion after its timeout', async () => {
  vi.useFakeTimers()
  const baseFixture = makeSessionFixture()
  const probeFixture = makeSessionFixture()
  let finish!: (text: string) => void
  const response = new Promise<string>(resolve => {
    finish = resolve
  })
  probeFixture.prompt.mockReturnValue(response)
  const pending = detectSessionModelName(
    { cloneCapable: false, namespace: 'modern', session: baseFixture.session },
    async () => probeFixture.session,
    10,
  )
  await vi.advanceTimersByTimeAsync(10)
  expect(await pending).toBeUndefined()
  finish('Gemini Nano')
  await response
  expect(probeFixture.destroy).toHaveBeenCalledTimes(1)
})

it('reports absent identity when session creation fails', async () => {
  const baseFixture = makeSessionFixture()
  const result = await detectSessionModelName(
    { cloneCapable: false, namespace: 'modern', session: baseFixture.session },
    async () => {
      throw new Error('fixture unavailable')
    },
  )
  expect(result).toBeUndefined()
  expect(baseFixture.destroy).not.toHaveBeenCalled()
})

it('disposes the model base if cancellation interrupts identity detection', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const baseFixture = makeSessionFixture()
  const probeFixture = makeSessionFixture()
  probeFixture.prompt.mockImplementation(async () => {
    controller.abort()
    return 'Gemini Nano'
  })
  const create = vi
    .fn()
    .mockResolvedValueOnce(baseFixture.session)
    .mockResolvedValueOnce(probeFixture.session)
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
  expect(baseFixture.destroy).toHaveBeenCalledTimes(1)
  await vi.runAllTimersAsync()
})
