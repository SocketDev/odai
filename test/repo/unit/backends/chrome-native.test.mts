import { afterEach, expect, it, vi } from 'vitest'

import {
  wrapNativeChromeFactory,
  wrapNativeChromeSession,
} from '../../../../src/backends/chrome-native.mts'
import type { NativeChromeSession } from '../../../../src/backends/chrome-native.mts'

afterEach(() => {
  vi.restoreAllMocks()
})

it('preserves the native stream and input messages without options', async () => {
  const nativeStream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue('fixture chunk')
      controller.close()
    },
  })
  const promptStreaming = vi.fn().mockReturnValue(nativeStream)
  const wrapped = wrapNativeChromeSession({ prompt: vi.fn(), promptStreaming })
  const messages = [{ role: 'user' as const, content: 'fixture request' }]
  expect(wrapped.promptStreaming(messages)).toBe(nativeStream)
  expect(promptStreaming).toHaveBeenCalledWith(messages)
  const reader = nativeStream.getReader()
  expect(await reader.read()).toEqual({ done: false, value: 'fixture chunk' })
  expect(await reader.read()).toEqual({ done: true, value: undefined })
  reader.releaseLock()
})

it('destroys late native clones and rejects use after idempotent destruction', async () => {
  const pendingClone = Promise.withResolvers<NativeChromeSession>()
  const destroySource = vi.fn()
  const destroyClone = vi.fn()
  const session = wrapNativeChromeSession({
    ...nativeSessionFixture(),
    clone: () => pendingClone.promise,
    destroy: destroySource,
  })
  const cloning = session.clone!()
  session.destroy!()
  session.destroy!()
  pendingClone.resolve({ ...nativeSessionFixture(), destroy: destroyClone })
  await expect(cloning).rejects.toMatchObject({ name: 'InvalidStateError' })
  expect(destroySource).toHaveBeenCalledOnce()
  expect(destroyClone).toHaveBeenCalledOnce()
  await expect(session.prompt([])).rejects.toMatchObject({
    name: 'InvalidStateError',
  })
  await expect(session.clone!()).rejects.toMatchObject({
    name: 'InvalidStateError',
  })
  expect(() => session.promptStreaming([])).toThrow('Session destroyed')
})

export function nativeSessionFixture(): NativeChromeSession {
  return {
    prompt: async () => 'reply',
    promptStreaming: () => new ReadableStream(),
  }
}

it('forwards native signals and initial prompts without replaying failed turns', async () => {
  const controller = new AbortController()
  const prompt = vi
    .fn()
    .mockRejectedValue(new Error('native failure after append'))
  const promptStreaming = vi.fn().mockReturnValue(new ReadableStream())
  const create = vi.fn().mockResolvedValue({ prompt, promptStreaming })
  const factory = wrapNativeChromeFactory({
    availability: async () => 'available',
    create,
  })
  const initialPrompts = [{ role: 'system', content: 'Keep history' }]
  const session = await factory.create({
    initialPrompts,
    abortSignal: controller.signal,
  })
  expect(factory.contextMode).toBe('native')
  expect(create).toHaveBeenCalledExactlyOnceWith({
    initialPrompts,
    signal: controller.signal,
  })
  const responseConstraint = { type: 'object' }
  await expect(
    session.prompt([], { abortSignal: controller.signal, responseConstraint }),
  ).rejects.toThrow('native failure')
  expect(prompt).toHaveBeenCalledExactlyOnceWith([], {
    responseConstraint,
    signal: controller.signal,
  })
  session.promptStreaming([], { abortSignal: controller.signal })
  expect(promptStreaming).toHaveBeenCalledExactlyOnceWith([], {
    signal: controller.signal,
  })
})

it('rejects early aborts and destroys a late session after creation is cancelled', async () => {
  const controller = new AbortController()
  const creation = Promise.withResolvers<NativeChromeSession>()
  const destroy = vi.fn()
  const create = vi.fn().mockReturnValue(creation.promise)
  const factory = wrapNativeChromeFactory({
    availability: async () => 'available',
    create,
  })
  const pending = factory.create({ abortSignal: controller.signal })
  const reason = new Error('cancelled create')
  controller.abort(reason)
  creation.resolve({ ...nativeSessionFixture(), destroy })
  await expect(pending).rejects.toBe(reason)
  expect(destroy).toHaveBeenCalledOnce()
  await expect(factory.create({ abortSignal: controller.signal })).rejects.toBe(
    reason,
  )
  expect(create).toHaveBeenCalledOnce()
  const prompt = vi.fn()
  const promptStreaming = vi.fn()
  const session = wrapNativeChromeSession({ prompt, promptStreaming })
  await expect(
    session.prompt([], { abortSignal: controller.signal }),
  ).rejects.toBe(reason)
  expect(() =>
    session.promptStreaming([], { abortSignal: controller.signal }),
  ).toThrow(reason)
  expect(prompt).not.toHaveBeenCalled()
  expect(promptStreaming).not.toHaveBeenCalled()
})

it('tracks overflow for the session and cloned history and removes listeners on destroy', async () => {
  const target = new EventTarget()
  const removeEventListener = vi.spyOn(target, 'removeEventListener')
  const session = wrapNativeChromeSession({
    ...nativeSessionFixture(),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    clone: async () => nativeSessionFixture(),
    contextUsage: 120,
    contextWindow: 1024,
  })
  expect(await session.contextStatus!()).toEqual({
    contextUsage: 120,
    contextWindow: 1024,
    overflowed: false,
  })
  target.dispatchEvent(new Event('contextoverflow'))
  expect((await session.contextStatus!()).overflowed).toBe(true)
  const clone = await session.clone!()
  expect((await clone.contextStatus!()).overflowed).toBe(true)
  session.destroy!()
  expect(removeEventListener).toHaveBeenCalledOnce()
})
