import { runInNewContext } from 'node:vm'

import { afterEach, expect, it, vi } from 'vitest'

import { compareContextSessions } from '../../../../src/bench/context.mts'
import type {
  ContextFactory,
  ContextSession,
} from '../../../../src/bench/context.mts'
import type { Message } from '../../../../src/types.mts'

interface SessionFixture {
  creationSignal: AbortSignal
  history: Message[]
  initial: Message[]
  persistent: boolean
  session: ContextSession
  streams: ReadableStream<string>[]
}

function createDeferredValue<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, reject, resolve }
}

function createFactoryFixture(
  intercept?: (
    fixture: SessionFixture,
    prompt: string,
    signal: AbortSignal,
  ) => ReadableStream<string> | undefined,
) {
  const sessions: SessionFixture[] = []
  const order: Array<{ persistent: boolean; prompt: string }> = []
  const create = vi.fn<ContextFactory['create']>(async options => {
    const initial = options.initialPrompts.map(message => ({ ...message }))
    const history = initial.map(message => ({ ...message }))
    const fixture: SessionFixture = {
      creationSignal: options.signal,
      history,
      initial,
      persistent: sessions.length % 4 === 0,
      session: {
        contextUsage: 50,
        contextWindow: 4096,
        destroy: vi.fn(),
        promptStreaming: vi.fn((prompt, { signal }) => {
          order.push({ persistent: fixture.persistent, prompt })
          const intercepted = intercept?.(fixture, prompt, signal)
          if (intercepted !== undefined) {
            fixture.streams.push(intercepted)
            return intercepted
          }
          const text = [
            ...history.map(message => message.content),
            prompt,
          ].join('\n')
          const code = text.match(/ORCHID-\d+/)?.[0] ?? 'UNKNOWN'
          const expected = prompt.endsWith('Reply READY.') ? 'READY' : code
          const output = fixture.persistent ? expected : expected + '\n'
          history.push(
            { role: 'user', content: prompt },
            { role: 'assistant', content: output },
          )
          const stream = new ReadableStream<string>({
            start(controller) {
              controller.enqueue(output.slice(0, 2))
              controller.enqueue(output.slice(2))
              controller.close()
            },
          })
          fixture.streams.push(stream)
          return stream
        }),
      },
      streams: [],
    }
    sessions.push(fixture)
    return fixture.session
  })
  vi.stubGlobal('LanguageModel', { create })
  return { create, order, sessions }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('replays the completed native history, isolates pairs, and remains serializable', async () => {
  vi.useFakeTimers()
  const fixture = createFactoryFixture()
  const compare = runInNewContext(`(${compareContextSessions.toString()})`, {
    AbortController,
    clearTimeout,
    DOMException,
    LanguageModel: { create: fixture.create },
    navigator: { userAgent: 'Fixture browser' },
    performance,
    setTimeout,
  }) as typeof compareContextSessions
  const report = await compare({ contextLines: 2, pairs: 2, timeoutMs: 100 })
  expect(report.userAgent).toBe('Fixture browser')
  expect(report.samples).toHaveLength(12)
  expect(report.samples.every(sample => sample.ok)).toBe(true)
  expect(fixture.sessions).toHaveLength(8)
  expect(fixture.order.map(entry => entry.persistent)).toEqual([
    false,
    true,
    true,
    false,
    false,
    true,
    true,
    false,
    false,
    true,
    true,
    false,
  ])
  for (let pair = 0; pair < 2; pair += 1) {
    const offset = pair * 4
    const persistent = fixture.sessions[offset]!
    expect(persistent.session.promptStreaming).toHaveBeenCalledTimes(3)
    for (let turn = 0; turn < 3; turn += 1) {
      const fresh = fixture.sessions[offset + turn + 1]!
      expect(fresh.initial).toEqual(persistent.history.slice(0, 1 + turn * 2))
      expect(fresh.session.promptStreaming).toHaveBeenCalledTimes(1)
      const samples = report.samples.filter(
        sample => sample.pair === pair && sample.turn === turn,
      )
      expect(samples[0]!.contextCharacters).toBe(samples[1]!.contextCharacters)
      const retained = samples.find(sample => sample.mode === 'persistent')!
      const replayed = samples.find(sample => sample.mode === 'fresh')!
      expect(replayed.inputCharacters).toBe(replayed.contextCharacters)
      if (turn > 0) {
        expect(retained.inputCharacters).toBe(
          fixture.order[pair * 6 + turn * 2]!.prompt.length,
        )
        expect(retained.inputCharacters).toBeLessThan(replayed.inputCharacters)
      }
    }
    expect(persistent.initial).toHaveLength(1)
  }
  for (const session of fixture.sessions) {
    expect(session.creationSignal.aborted).toBe(false)
    expect(session.session.destroy).toHaveBeenCalledTimes(1)
    expect(session.streams.every(stream => !stream.locked)).toBe(true)
  }
  expect(vi.getTimerCount()).toBe(0)
})

it('clears a creation deadline while the persistent conversation remains active', async () => {
  vi.useFakeTimers()
  const first = createDeferredValue<ReadableStreamDefaultController<string>>()
  const second = createDeferredValue<ReadableStreamDefaultController<string>>()
  let prompts = 0
  const fixture = createFactoryFixture(() => {
    prompts += 1
    if (prompts > 2) {
      return undefined
    }
    return new ReadableStream<string>({
      start(controller) {
        const pending = prompts === 1 ? first : second
        pending.resolve(controller)
      },
    })
  })
  const pending = compareContextSessions({
    contextLines: 0,
    pairs: 1,
    timeoutMs: 100,
  })
  const firstController = await first.promise
  await vi.advanceTimersByTimeAsync(60)
  firstController.enqueue('READY')
  firstController.close()
  const secondController = await second.promise
  await vi.advanceTimersByTimeAsync(60)
  expect(fixture.sessions[0]!.creationSignal.aborted).toBe(false)
  secondController.enqueue('READY')
  secondController.close()
  await pending
  expect(vi.getTimerCount()).toBe(0)
})

it.each([0, 1])(
  'bounds session creation and disposes a late session at position %i',
  async blockedIndex => {
    vi.useFakeTimers()
    const created = createDeferredValue<ContextSession>()
    const began = createDeferredValue<void>()
    const fixture = createFactoryFixture()
    const original = fixture.create.getMockImplementation()!
    fixture.create.mockImplementation(options => {
      if (fixture.sessions.length === blockedIndex) {
        began.resolve()
        return created.promise
      }
      return original(options)
    })
    const pending = compareContextSessions({
      contextLines: 0,
      pairs: 1,
      timeoutMs: 100,
    }).catch(error => error as Error)
    await began.promise
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ name: 'TimeoutError' })
    const late: ContextSession = {
      destroy: vi.fn(),
      promptStreaming: () => new ReadableStream<string>(),
    }
    created.resolve(late)
    await vi.advanceTimersByTimeAsync(0)
    expect(late.destroy).toHaveBeenCalledTimes(1)
    for (const session of fixture.sessions) {
      expect(session.session.destroy).toHaveBeenCalledTimes(1)
    }
    expect(vi.getTimerCount()).toBe(0)
  },
)

it.each(['prompt', 'read'])(
  'disposes both sessions after a %s failure',
  async stage => {
    vi.useFakeTimers()
    const failure = new Error('Fixture generation failure')
    const fixture = createFactoryFixture(() => {
      if (stage === 'prompt') {
        throw failure
      }
      return new ReadableStream<string>({
        start(controller) {
          controller.error(failure)
        },
      })
    })
    await expect(
      compareContextSessions({ contextLines: 0, pairs: 1, timeoutMs: 100 }),
    ).rejects.toBe(failure)
    expect(fixture.sessions).toHaveLength(2)
    for (const session of fixture.sessions) {
      expect(session.session.destroy).toHaveBeenCalledTimes(1)
      expect(session.streams.every(stream => !stream.locked)).toBe(true)
    }
    expect(vi.getTimerCount()).toBe(0)
  },
)

it('cancels a stalled read without waiting for cancellation to finish', async () => {
  vi.useFakeTimers()
  const began = createDeferredValue<AbortSignal>()
  const cleanup = createDeferredValue<void>()
  const cancel = vi.fn(() => cleanup.promise)
  const stream = new ReadableStream<string>({ cancel })
  const fixture = createFactoryFixture((session, prompt, signal) => {
    void session
    void prompt
    began.resolve(signal)
    return stream
  })
  const pending = compareContextSessions({
    contextLines: 0,
    pairs: 1,
    timeoutMs: 100,
  }).catch(error => error as Error)
  const signal = await began.promise
  await vi.advanceTimersByTimeAsync(100)
  expect(await pending).toMatchObject({ name: 'TimeoutError' })
  expect(signal.aborted).toBe(true)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(stream.locked).toBe(false)
  for (const session of fixture.sessions) {
    expect(session.session.destroy).toHaveBeenCalledTimes(1)
  }
  expect(vi.getTimerCount()).toBe(0)
  cleanup.reject(new Error('Late cancellation failure'))
})

it('rejects a browser without the native factory', async () => {
  vi.stubGlobal('LanguageModel', undefined)
  await expect(
    compareContextSessions({ contextLines: 0, pairs: 1, timeoutMs: 100 }),
  ).rejects.toBeInstanceOf(Error)
})
