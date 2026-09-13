import { afterEach, expect, it, vi } from 'vitest'

import { createPageBoundFactory } from '../../../../../src/backends/chrome-page/factory.mts'
import { pageBeginOperation } from '../../../../../src/backends/chrome-page/operations.mts'
import {
  pageCloneSession,
  pageCreateSession,
  pageDestroySession,
} from '../../../../../src/backends/chrome-page/sessions.mts'
import type {
  NativeChromeFactory,
  NativeChromeSession,
} from '../../../../../src/backends/chrome-native.mts'
import type {
  Bridge,
  PageGlobalState,
  PageLike,
  StreamPayload,
} from '../../../../../src/backends/chrome-page/types.mts'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('destroys once and rejects operations after the page session is closed', async () => {
  const destroy = vi.fn()
  const bridge = pageBridgeFixture({
    destroy,
    prompt: async () => 'reply',
    promptStreaming: () => new ReadableStream(),
  })
  const session = await createPageBoundFactory(bridge).create()
  session.destroy!()
  session.destroy!()
  await expect(session.prompt([])).rejects.toMatchObject({
    name: 'InvalidStateError',
  })
  expect(() => session.contextStatus!()).toThrow('Session destroyed')
  expect(() => session.promptStreaming([])).toThrow('Session destroyed')
  expect(destroy).toHaveBeenCalledOnce()
})

it('propagates session creation errors from the page factory', async () => {
  const bridge = pageBridgeFixture({
    prompt: async () => 'reply',
    promptStreaming: () => new ReadableStream(),
  })
  vi.stubGlobal('LanguageModel', {
    create: async () => {
      throw new DOMException('creation rejected', 'QuotaExceededError')
    },
  })
  await expect(createPageBoundFactory(bridge).create()).rejects.toMatchObject({
    name: 'QuotaExceededError',
    message: 'creation rejected',
  })
})

it.each([{ cleanupFails: false }, { cleanupFails: true }])(
  'rejects a delivered clone after source destruction with cleanup failure=$cleanupFails',
  async ({ cleanupFails }) => {
    const native = {
      prompt: async () => 'reply',
      promptStreaming: () => new ReadableStream(),
    }
    const destroyClone = vi.fn()
    const bridge = pageBridgeFixture({
      ...native,
      clone: async () => ({ ...native, destroy: destroyClone }),
    })
    const session = await createPageBoundFactory(bridge).create()
    const created = Promise.withResolvers<void>()
    const delivery = Promise.withResolvers<void>()
    const cleanup = vi.fn()
    let channelClosed = false
    const evaluate = bridge.page.evaluate.bind(bridge.page)
    bridge.page.evaluate = async <T,>(
      fn: unknown,
      arg?: unknown,
    ): Promise<T> => {
      if (fn === pageDestroySession) {
        cleanup()
        if (channelClosed) {
          throw new Error('cleanup channel closed')
        }
      }
      const result = await evaluate<T>(fn, arg)
      if (fn === pageCloneSession) {
        created.resolve()
        await delivery.promise
      }
      return result
    }
    const cloning = session.clone!()
    await created.promise
    session.destroy!()
    channelClosed = cleanupFails
    delivery.resolve()
    await expect(cloning).rejects.toMatchObject({ name: 'InvalidStateError' })
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(destroyClone).toHaveBeenCalledTimes(cleanupFails ? 0 : 1)
  },
)

it('preserves cancellation when a late-created session cannot be destroyed over the closed page channel', async () => {
  const bridge = pageBridgeFixture({
    prompt: async () => 'reply',
    promptStreaming: () => new ReadableStream(),
  })
  const created = Promise.withResolvers<void>()
  const delivery = Promise.withResolvers<void>()
  const cleanup = vi.fn()
  const evaluate = bridge.page.evaluate.bind(bridge.page)
  bridge.page.evaluate = async <T,>(fn: unknown, arg?: unknown): Promise<T> => {
    if (fn === pageDestroySession) {
      cleanup()
      throw new Error('cleanup channel closed')
    }
    const result = await evaluate<T>(fn, arg)
    if (fn === pageCreateSession) {
      created.resolve()
      await delivery.promise
    }
    return result
  }
  const controller = new AbortController()
  const creation = createPageBoundFactory(bridge).create({
    abortSignal: controller.signal,
  })
  await created.promise
  const reason = new Error('cancel creation')
  controller.abort(reason)
  await expect(creation).rejects.toBe(reason)
  delivery.resolve()
  await vi.waitFor(() => {
    expect(cleanup).toHaveBeenCalledOnce()
  })
})

it('destroys a native session when its creation receipt arrives after cancellation', async () => {
  const destroy = vi.fn()
  const bridge = pageBridgeFixture({
    destroy,
    prompt: async () => 'reply',
    promptStreaming: () => new ReadableStream(),
  })
  const created = Promise.withResolvers<void>()
  const delivery = Promise.withResolvers<void>()
  const evaluate = bridge.page.evaluate.bind(bridge.page)
  bridge.page.evaluate = async <T,>(fn: unknown, arg?: unknown): Promise<T> => {
    const result = await evaluate<T>(fn, arg)
    if (fn === pageCreateSession) {
      created.resolve()
      await delivery.promise
    }
    return result
  }
  const controller = new AbortController()
  const creation = createPageBoundFactory(bridge).create({
    abortSignal: controller.signal,
  })
  await created.promise
  controller.abort(new Error('cancel creation receipt'))
  await expect(creation).rejects.toThrow('cancel creation receipt')
  delivery.resolve()
  await vi.waitFor(() => {
    expect(destroy).toHaveBeenCalledOnce()
  })
  expect(pageGlobalFixture().__odaiSessions?.size).toBe(0)
  expect(pageGlobalFixture().__odaiContexts?.size).toBe(0)
})

it('disposes late clones after destroying an overflowing source session', async () => {
  const pendingClone = Promise.withResolvers<NativeChromeSession>()
  const target = new EventTarget()
  const destroyClone = vi.fn()
  const bridge = pageBridgeFixture({
    addEventListener: target.addEventListener.bind(target),
    clone: () => pendingClone.promise,
    prompt: async () => 'reply',
    promptStreaming: () => new ReadableStream(),
  })
  const session = await createPageBoundFactory(bridge).create()
  target.dispatchEvent(new Event('contextoverflow'))
  const cloning = session.clone!()
  session.destroy!()
  pendingClone.resolve({
    destroy: destroyClone,
    prompt: async () => 'reply',
    promptStreaming: () => new ReadableStream(),
  })
  await expect(cloning).rejects.toMatchObject({ name: 'InvalidStateError' })
  expect(destroyClone).toHaveBeenCalledOnce()
  expect(pageGlobalFixture().__odaiSessions?.size).toBe(0)
  expect(pageGlobalFixture().__odaiContexts?.size).toBe(0)
})

export function pageBridgeFixture(native: NativeChromeSession): Bridge {
  const streams = new Map()
  vi.stubGlobal('__odaiSessions', new Map())
  vi.stubGlobal('__odaiContexts', new Map())
  vi.stubGlobal('__odaiOperations', new Map())
  vi.stubGlobal('LanguageModel', {
    availability: async () => 'available',
    create: async () => native,
  })
  vi.stubGlobal('__odaiStreamChunk', async (payload: StreamPayload) => {
    streams.get(payload.streamId)?.push(payload)
  })
  const page: PageLike = {
    async evaluate<T>(fn: unknown, arg?: unknown): Promise<T> {
      return await (fn as (payload: unknown) => T)(arg)
    },
    exposeFunction: async () => undefined,
    goto: async () => undefined,
  }
  return { close: async () => undefined, page, streams }
}

export function pageGlobalFixture(): PageGlobalState {
  return globalThis as PageGlobalState
}

it('preserves initial prompts, reports native context and never retries a failed constraint', async () => {
  const target = new EventTarget()
  const prompt = vi
    .fn()
    .mockRejectedValue(new Error('failed after consuming input'))
  const bridge = pageBridgeFixture({
    addEventListener: target.addEventListener.bind(target),
    contextUsage: 7,
    contextWindow: 100,
    prompt,
    promptStreaming: () => new ReadableStream(),
  })
  const create = vi.spyOn(
    (globalThis as unknown as { LanguageModel: NativeChromeFactory })
      .LanguageModel,
    'create',
  )
  const factory = createPageBoundFactory(bridge)
  const initialPrompts = [{ role: 'system', content: 'Retain history' }]
  const session = await factory.create({ initialPrompts })
  expect(create).toHaveBeenCalledWith({ initialPrompts })
  expect(factory.contextMode).toBe('native')
  expect(await session.contextStatus!()).toEqual({
    contextUsage: 7,
    contextWindow: 100,
    overflowed: false,
  })
  target.dispatchEvent(new Event('contextoverflow'))
  expect((await session.contextStatus!()).overflowed).toBe(true)
  await expect(
    session.prompt([], { responseConstraint: { type: 'object' } }),
  ).rejects.toThrow('failed after consuming input')
  expect(prompt).toHaveBeenCalledOnce()
  expect(pageGlobalFixture().__odaiOperations?.size).toBe(0)
})

it('cancels before delayed browser registration without starting a native turn', async () => {
  const prompt = vi.fn().mockResolvedValue('late reply')
  const bridge = pageBridgeFixture({
    prompt,
    promptStreaming: () => new ReadableStream(),
  })
  const session = await createPageBoundFactory(bridge).create()
  const registration = Promise.withResolvers<void>()
  const evaluate = bridge.page.evaluate.bind(bridge.page)
  bridge.page.evaluate = async <T,>(fn: unknown, arg?: unknown): Promise<T> => {
    if (fn === pageBeginOperation) {
      await registration.promise
    }
    return evaluate<T>(fn, arg)
  }
  const controller = new AbortController()
  const reason = new Error('early cancellation')
  const pending = session.prompt([], { abortSignal: controller.signal })
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  registration.resolve()
  await vi.waitFor(() => {
    expect(pageGlobalFixture().__odaiOperations?.size).toBe(0)
  })
  expect(prompt).not.toHaveBeenCalled()
})

it('forwards prompt cancellation and ignores aborts after successful completion', async () => {
  const reply = Promise.withResolvers<string>()
  let signal: AbortSignal | undefined
  const prompt = vi.fn((messages, options) => {
    void messages
    signal = options.signal
    return reply.promise
  })
  const bridge = pageBridgeFixture({
    prompt,
    promptStreaming: () => new ReadableStream(),
  })
  const session = await createPageBoundFactory(bridge).create()
  const controller = new AbortController()
  const pending = session.prompt([], { abortSignal: controller.signal })
  await vi.waitFor(() => {
    expect(signal).toBeInstanceOf(AbortSignal)
  })
  controller.abort(new Error('cancel turn'))
  await expect(pending).rejects.toThrow('cancel turn')
  await vi.waitFor(() => {
    expect(signal?.aborted).toBe(true)
  })
  expect(pageGlobalFixture().__odaiOperations?.size).toBe(0)
  reply.resolve('ignored late reply')
  const completedController = new AbortController()
  expect(
    await session.prompt([], { abortSignal: completedController.signal }),
  ).toBe('ignored late reply')
  const completedSignal = signal
  completedController.abort()
  await Promise.resolve()
  expect(completedSignal?.aborted).toBe(false)
  expect(pageGlobalFixture().__odaiOperations?.size).toBe(0)
})

it('returns from a blocked stream, cancels the native reader and releases its lock', async () => {
  const cancel = vi.fn()
  const nativeStream = new ReadableStream<string>({ cancel })
  let signal: AbortSignal | undefined
  const bridge = pageBridgeFixture({
    prompt: async () => 'reply',
    promptStreaming(messages, options) {
      void messages
      signal = options?.signal
      return nativeStream
    },
  })
  const session = await createPageBoundFactory(bridge).create()
  const iterator = (session.promptStreaming([]) as AsyncIterable<string>)[
    Symbol.asyncIterator
  ]()
  const pending = iterator.next()
  await vi.waitFor(() => {
    expect(nativeStream.locked).toBe(true)
  })
  await expect(iterator.return!()).resolves.toEqual({
    done: true,
    value: undefined,
  })
  await expect(pending).resolves.toEqual({ done: true, value: undefined })
  await vi.waitFor(() => {
    expect(nativeStream.locked).toBe(false)
  })
  expect(signal?.aborted).toBe(true)
  expect(cancel).toHaveBeenCalledOnce()
  expect(bridge.streams.size).toBe(0)
  expect(pageGlobalFixture().__odaiOperations?.size).toBe(0)
})

it('does not start an unconsumed stream and rejects a pending stream when the session is destroyed', async () => {
  const promptStreaming = vi.fn().mockImplementation(() => new ReadableStream())
  const bridge = pageBridgeFixture({
    prompt: async () => 'reply',
    promptStreaming,
  })
  const session = await createPageBoundFactory(bridge).create()
  const unopened = (session.promptStreaming([]) as AsyncIterable<string>)[
    Symbol.asyncIterator
  ]()
  await unopened.return!()
  expect(promptStreaming).not.toHaveBeenCalled()
  const iterator = (session.promptStreaming([]) as AsyncIterable<string>)[
    Symbol.asyncIterator
  ]()
  const pending = iterator.next()
  await vi.waitFor(() => {
    expect(promptStreaming).toHaveBeenCalledOnce()
  })
  session.destroy!()
  await expect(pending).rejects.toThrow('Session destroyed')
  await vi.waitFor(() => {
    expect(pageGlobalFixture().__odaiSessions?.size).toBe(0)
  })
  expect(bridge.streams.size).toBe(0)
  expect(pageGlobalFixture().__odaiContexts?.size).toBe(0)
  expect(pageGlobalFixture().__odaiOperations?.size).toBe(0)
})
