import { expect, it, vi } from 'vitest'
import { createConversation } from '../../../../src/conversation/create.mts'
import {
  assertConversationOperation,
  createConversationState,
  destroyConversationState,
  resetConversationState,
  waitForConversation,
} from '../../../../src/conversation/state.mts'
import type { SessionLike } from '../../../../src/types.mts'
import { conversationFactory } from './fixture/model.mts'

it('rejects an operation from a previous generation even when its own signal remains active', () => {
  const fixture = conversationFactory()
  const state = createConversationState(fixture.factory, {})
  const previous = {
    generation: state.generation,
    signal: new AbortController().signal,
  }
  resetConversationState(state, [])
  expect(previous.signal.aborted).toBe(false)
  expect(() => assertConversationOperation(state, previous)).toThrow(
    expect.objectContaining({ name: 'AbortError' }),
  )
  expect(() =>
    assertConversationOperation(state, {
      generation: state.generation,
      signal: state.controller.signal,
    }),
  ).not.toThrow()
  destroyConversationState(state)
})

it('fences cancellation that occurs after resolution but before the awaiting continuation', async () => {
  const value = Promise.withResolvers<string>()
  const controller = new AbortController()
  const reason = new Error('cancelled at the await boundary')
  const pending = waitForConversation(value.promise, controller.signal).catch(
    error => error,
  )
  value.resolve('too late')
  queueMicrotask(() => controller.abort(reason))
  expect(await pending).toBe(reason)
})

it('rejects pre-aborted creation and requests without starting a session', async () => {
  const fixture = conversationFactory()
  const controller = new AbortController()
  const reason = new Error('cancelled')
  controller.abort(reason)
  await expect(
    createConversation(fixture.factory, { abortSignal: controller.signal }),
  ).rejects.toBe(reason)
  const chat = await createConversation(fixture.factory)
  await expect(
    chat.prompt('input', { abortSignal: controller.signal }),
  ).rejects.toBe(reason)
  expect(fixture.factory.create).not.toHaveBeenCalled()
  chat.destroy()
})

it('detaches the creation signal from a successful request signal', async () => {
  const fixture = conversationFactory()
  const controller = new AbortController()
  const chat = await createConversation(fixture.factory)
  await chat.prompt('first', { abortSignal: controller.signal })
  controller.abort()
  expect(fixture.sessions[0]!.signal!.aborted).toBe(false)
  await chat.prompt('second')
  expect(fixture.factory.create).toHaveBeenCalledOnce()
  chat.destroy()
})

it('aborts pending creation promptly and disposes a late session once', async () => {
  const fixture = conversationFactory()
  const originalCreate = fixture.factory.create.bind(fixture.factory)
  const lateSession = await originalCreate()
  const created = Promise.withResolvers<SessionLike>()
  const started = Promise.withResolvers<AbortSignal>()
  fixture.factory.create = vi.fn(options => {
    started.resolve((options as { abortSignal: AbortSignal }).abortSignal)
    return created.promise
  })
  const controller = new AbortController()
  const chat = await createConversation(fixture.factory)
  const pending = chat
    .prompt('late', { abortSignal: controller.signal })
    .catch(error => error)
  const creationSignal = await started.promise
  const reason = new Error('stop creation')
  controller.abort(reason)
  expect(await pending).toBe(reason)
  expect(creationSignal.aborted).toBe(true)
  created.resolve(lateSession)
  await created.promise
  await Promise.resolve()
  expect(lateSession.destroy).toHaveBeenCalledOnce()
  expect(chat.messages()).toEqual([])
  chat.destroy()
})

it('fences reset from late output and permits a fresh request immediately', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory, {
    systemPrompt: 'seed',
  })
  await chat.prompt('saved')
  const late = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  fixture.sessions[0]!.session.prompt = vi.fn(() => {
    started.resolve()
    return late.promise
  })
  const pending = chat.prompt('old').catch(error => error)
  const queued = chat.prompt('never').catch(error => error)
  await started.promise
  chat.reset([])
  await expect(chat.prompt('new')).resolves.toBe('answer')
  expect(await pending).toMatchObject({ name: 'AbortError' })
  expect(await queued).toMatchObject({ name: 'AbortError' })
  late.resolve('discard this')
  await late.promise
  expect(chat.messages()).toEqual([
    { role: 'user', content: 'new' },
    { role: 'assistant', content: 'answer' },
  ])
  expect(fixture.sessions[0]!.session.prompt).toHaveBeenCalledOnce()
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
  expect(fixture.sessions[1]!.session.destroy).not.toHaveBeenCalled()
  chat.destroy()
})

it('cancels queued requests without sending them to the provider', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory)
  await chat.prompt('saved')
  const pendingReply = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  fixture.sessions[0]!.session.prompt = vi.fn(() => {
    started.resolve()
    return pendingReply.promise
  })
  const first = chat.prompt('pending')
  const controller = new AbortController()
  const queued = chat
    .prompt('never', { abortSignal: controller.signal })
    .catch(error => error)
  await started.promise
  controller.abort()
  expect(await queued).toMatchObject({ name: 'AbortError' })
  pendingReply.resolve('reply')
  await first
  await chat.contextStatus()
  expect(fixture.sessions[0]!.session.prompt).toHaveBeenCalledOnce()
  chat.destroy()
})

it('disposes uncertain context after a status failure without harming a replacement', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory)
  await chat.prompt('saved')
  const status = Promise.withResolvers<never>()
  const started = Promise.withResolvers<void>()
  fixture.sessions[0]!.session.contextStatus = () => {
    started.resolve()
    return status.promise
  }
  const pending = chat.contextStatus().catch(error => error)
  await started.promise
  chat.reset([])
  await chat.prompt('new')
  status.reject(new Error('late failure'))
  expect(await pending).toMatchObject({ name: 'AbortError' })
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
  expect(fixture.sessions[1]!.session.destroy).not.toHaveBeenCalled()
  fixture.sessions[1]!.session.contextStatus = () => {
    throw new Error('status failed')
  }
  await expect(chat.contextStatus()).rejects.toThrow('status failed')
  expect(fixture.sessions[1]!.session.destroy).toHaveBeenCalledOnce()
  chat.destroy()
})

it('closes on lifetime cancellation and makes destruction idempotent', async () => {
  const fixture = conversationFactory()
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  const chat = await createConversation(fixture.factory, {
    abortSignal: controller.signal,
  })
  await chat.prompt('saved')
  controller.abort()
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  chat.destroy()
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
  expect(() => chat.messages()).toThrow(
    expect.objectContaining({ code: 'CONVERSATION_CLOSED' }),
  )
  expect(() => chat.reset()).toThrow(
    expect.objectContaining({ code: 'CONVERSATION_CLOSED' }),
  )
  await expect(chat.prompt('closed')).rejects.toMatchObject({
    code: 'CONVERSATION_CLOSED',
  })
  await expect(chat.contextStatus()).rejects.toMatchObject({
    code: 'CONVERSATION_CLOSED',
  })
})
