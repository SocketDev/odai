import { expect, it, vi } from 'vitest'
import { createConversation } from '../../../../src/conversation/create.mts'
import { ConversationError } from '../../../../src/conversation/transcript.mts'
import {
  conversationFactory,
  conversationTranscript,
} from './fixture/model.mts'

it('creates lazily, seeds native history once, and sends only new turns', async () => {
  const fixture = conversationFactory()
  const initial = conversationTranscript()
  const chat = await createConversation(fixture.factory, {
    initialPrompts: initial,
    systemPrompt: 'instruction',
    temperature: 0.2,
    topK: 3,
  })
  expect(await chat.contextStatus()).toMatchObject({ mode: 'native', turns: 1 })
  expect(fixture.factory.create).not.toHaveBeenCalled()
  await expect(chat.prompt('first')).resolves.toBe('answer')
  await expect(chat.prompt('second')).resolves.toBe('answer')
  expect(fixture.factory.create).toHaveBeenCalledTimes(1)
  expect(fixture.factory.create).toHaveBeenCalledWith(
    expect.objectContaining({
      initialPrompts: initial,
      temperature: 0.2,
      topK: 3,
    }),
  )
  expect(fixture.calls).toEqual([
    [{ role: 'user', content: 'first' }],
    [{ role: 'user', content: 'second' }],
  ])
  expect(chat.messages()).toHaveLength(7)
  expect(await chat.contextStatus()).toMatchObject({
    characters: chat
      .messages()
      .reduce((count, message) => count + message.content.length, 0),
    turns: 3,
  })
  chat.destroy()
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledTimes(1)
})

it.each(['replay', undefined] as const)(
  'replays complete committed history for capability %s',
  async mode => {
    const fixture = conversationFactory(mode)
    const factory =
      mode === undefined
        ? { ...fixture.factory, contextMode: undefined }
        : fixture.factory
    const initial = conversationTranscript()
    const chat = await createConversation(factory, { initialPrompts: initial })
    await chat.prompt('first')
    const committed = chat.messages()
    await chat.prompt('second')
    expect(fixture.sessions).toHaveLength(2)
    expect(fixture.sessions.map(session => session.initial)).toEqual([[], []])
    expect(fixture.calls).toEqual([
      [...initial, { role: 'user', content: 'first' }],
      [...committed, { role: 'user', content: 'second' }],
    ])
    for (const { session } of fixture.sessions) {
      expect(session.destroy).toHaveBeenCalledTimes(1)
    }
    chat.destroy()
  },
)

it('serializes requests and snapshots their options before waiting', async () => {
  const fixture = conversationFactory()
  const first = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  const create = fixture.factory.create.bind(fixture.factory)
  fixture.factory.create = async options => {
    const session = await create(options)
    const prompt = session.prompt.bind(session)
    session.prompt = (messages, promptOptions) => {
      started.resolve()
      return prompt(messages, promptOptions)
    }
    return session
  }
  fixture.responses.push(first.promise, 'second')
  const chat = await createConversation(fixture.factory)
  const original = new AbortController()
  const replacement = new AbortController()
  const options = { abortSignal: original.signal }
  const firstPrompt = chat.prompt('first')
  const secondPrompt = chat.prompt('second', options)
  options.abortSignal = replacement.signal
  replacement.abort()
  await started.promise
  expect(fixture.calls).toHaveLength(1)
  first.resolve('first answer')
  await expect(firstPrompt).resolves.toBe('first answer')
  await expect(secondPrompt).resolves.toBe('second')
  expect(chat.messages().map(message => message.content)).toEqual([
    'first',
    'first answer',
    'second',
    'second',
  ])
  chat.destroy()
})

it('exports defensive history that another conversation can restore', async () => {
  const fixture = conversationFactory()
  const initial = conversationTranscript()
  const chat = await createConversation(fixture.factory, {
    initialPrompts: initial,
  })
  initial[1]!.content = 'mutated'
  await chat.prompt('new')
  const saved = chat.messages()
  const restored = await createConversation(fixture.factory, {
    initialPrompts: saved,
  })
  saved[1]!.content = 'changed export'
  expect(restored.messages()).toEqual(chat.messages())
  const exported = restored.messages()
  exported.pop()
  expect(restored.messages()).toHaveLength(5)
  await restored.prompt('continued')
  expect(fixture.sessions[1]!.initial).toEqual(chat.messages())
  chat.destroy()
  restored.destroy()
})

it('preserves provider failures and rebuilds only from completed turns', async () => {
  const fixture = conversationFactory()
  const failure = new Error('provider failed')
  fixture.responses.push('saved', failure, 'recovered')
  const chat = await createConversation(fixture.factory)
  await chat.prompt('first')
  const committed = chat.messages()
  await expect(chat.prompt('bad')).rejects.toBe(failure)
  expect(chat.messages()).toEqual(committed)
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledTimes(1)
  await expect(chat.prompt('retry')).resolves.toBe('recovered')
  expect(fixture.sessions[1]!.initial).toEqual(committed)
  chat.destroy()
})

it('rejects empty output, native history loss, and missing native status', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory)
  fixture.responses.push('')
  await expect(chat.prompt('empty')).rejects.toMatchObject({
    code: 'CONVERSATION_RESPONSE',
  })
  await chat.prompt('saved')
  fixture.sessions[1]!.session.contextStatus = () => ({ overflowed: true })
  await expect(chat.prompt('overflow')).rejects.toMatchObject({
    code: 'CONVERSATION_OVERFLOW',
  })
  expect(fixture.calls).toHaveLength(2)
  await chat.prompt('rebuild')
  delete fixture.sessions[2]!.session.contextStatus
  await expect(chat.prompt('unknown')).rejects.toMatchObject({
    code: 'CONVERSATION_CONTEXT',
  })
  expect(chat.messages().map(message => message.content)).toEqual([
    'saved',
    'answer',
    'rebuild',
    'answer',
  ])
  chat.destroy()
})

it('does not commit a turn that overflows the native context after generation', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory)
  await chat.prompt('saved')
  fixture.sessions[0]!.session.contextStatus = vi
    .fn()
    .mockReturnValueOnce({ overflowed: false })
    .mockReturnValue({ overflowed: false, contextUsage: 11, contextWindow: 10 })
  await expect(chat.prompt('overflow')).rejects.toMatchObject({
    code: 'CONVERSATION_OVERFLOW',
  })
  expect(chat.messages()).toHaveLength(2)
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
  expect(new ConversationError('CODE', 'detail')).toMatchObject({
    code: 'CODE',
    name: 'ConversationError',
    message: 'detail',
  })
  chat.destroy()
})
