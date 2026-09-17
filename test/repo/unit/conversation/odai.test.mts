import { afterEach, expect, it, vi } from 'vitest'
import {
  createOdaiConversation,
  ownConversationBackend,
} from '../../../../src/conversation/odai.mts'
import { createConversation } from '../../../../src/conversation/create.mts'
import type { OdaiBackend } from '../../../../src/backends/types.mts'
import { conversationFactory } from './fixture/model.mts'
import { conversationTranscript } from './fixture/model.mts'

const mocks = vi.hoisted(() => ({ selectBackend: vi.fn() }))
vi.mock('../../../../src/backends/registry.mts', () => mocks)

afterEach(() => {
  vi.resetAllMocks()
})

it('snapshots initial history before asynchronous backend discovery', async () => {
  const fixture = conversationBackend()
  const selected = Promise.withResolvers<OdaiBackend>()
  mocks.selectBackend.mockReturnValue(selected.promise)
  const initialPrompts = conversationTranscript()
  const expected = structuredClone(initialPrompts)
  const pending = createOdaiConversation({ initialPrompts })
  initialPrompts[1]!.content = 'changed while discovering'
  selected.resolve(fixture.backend)
  const chat = await pending
  expect(chat.messages()).toEqual(expected)
  chat.destroy()
})

function conversationBackend() {
  const fixture = conversationFactory()
  const backend = {
    availability: async () => ({ available: true }),
    close: vi.fn(async () => undefined),
    languageModel: vi.fn(async () => fixture.factory),
    name: 'chrome-builtin' as const,
  }
  mocks.selectBackend.mockResolvedValue(backend)
  return { ...fixture, backend }
}

it('preserves backend selection failures before a factory exists', async () => {
  const fixture = conversationBackend()
  const reason = new Error('backend unavailable')
  mocks.selectBackend.mockRejectedValue(reason)
  await expect(createOdaiConversation()).rejects.toBe(reason)
  expect(fixture.backend.languageModel).not.toHaveBeenCalled()
  expect(fixture.backend.close).not.toHaveBeenCalled()
})

it('cleans up when ownership transfers after the lifetime signal aborted', async () => {
  const fixture = conversationBackend()
  const chat = await createConversation(fixture.factory)
  await chat.prompt('first')
  const controller = new AbortController()
  const reason = new Error('cancelled before ownership transfer')
  controller.abort(reason)
  expect(() =>
    ownConversationBackend(chat, fixture.backend, controller.signal),
  ).toThrow(reason)
  expect(fixture.backend.close).toHaveBeenCalledOnce()
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
  expect(() => chat.messages()).toThrow(
    expect.objectContaining({ code: 'CONVERSATION_CLOSED' }),
  )
})

it('does not leak an unhandled rejection when backend cleanup fails', async () => {
  const fixture = conversationBackend()
  const reason = new Error('backend cleanup failed')
  fixture.backend.close.mockRejectedValue(reason)
  const chat = await createOdaiConversation()
  expect(() => chat.destroy()).not.toThrow()
  await Promise.resolve()
  expect(fixture.backend.close).toHaveBeenCalledOnce()
})

it('closes an internally selected backend with its conversation', async () => {
  const fixture = conversationBackend()
  const chat = await createOdaiConversation({
    backend: 'chrome-builtin',
    systemPrompt: 'instruction',
  })
  expect(fixture.factory.create).not.toHaveBeenCalled()
  await chat.prompt('hello')
  expect(fixture.calls).toEqual([[{ role: 'user', content: 'hello' }]])
  chat.destroy()
  chat.destroy()
  expect(fixture.backend.close).toHaveBeenCalledOnce()
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
})

it('keeps caller-owned backends open while destroying owned sessions', async () => {
  const fixture = conversationBackend()
  const chat = await createOdaiConversation({ backend: fixture.backend })
  await chat.prompt('hello')
  chat.destroy()
  expect(fixture.backend.close).not.toHaveBeenCalled()
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
})

it('closes an internally selected backend on lifetime abort', async () => {
  const fixture = conversationBackend()
  const controller = new AbortController()
  const chat = await createOdaiConversation({ abortSignal: controller.signal })
  controller.abort()
  expect(fixture.backend.close).toHaveBeenCalledOnce()
  await expect(chat.prompt('closed')).rejects.toMatchObject({
    code: 'CONVERSATION_CLOSED',
  })
})

it('releases a late backend after selection was cancelled', async () => {
  const fixture = conversationBackend()
  const selected = Promise.withResolvers<OdaiBackend>()
  mocks.selectBackend.mockReturnValue(selected.promise)
  const controller = new AbortController()
  const pending = createOdaiConversation({
    abortSignal: controller.signal,
  }).catch(error => error)
  controller.abort()
  expect(await pending).toMatchObject({ name: 'AbortError' })
  selected.resolve(fixture.backend)
  await selected.promise
  expect(fixture.backend.close).toHaveBeenCalledOnce()
  expect(fixture.backend.languageModel).not.toHaveBeenCalled()
})

it('closes its backend on factory failure and preserves the cause', async () => {
  const fixture = conversationBackend()
  const failure = new Error('factory failure')
  fixture.backend.languageModel.mockRejectedValue(failure)
  await expect(createOdaiConversation()).rejects.toBe(failure)
  expect(fixture.backend.close).toHaveBeenCalledOnce()
})
