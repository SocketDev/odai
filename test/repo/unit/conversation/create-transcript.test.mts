import { expect, it } from 'vitest'
import { createConversation } from '../../../../src/conversation/create.mts'
import type { ConversationOptions } from '../../../../src/conversation/types.mts'
import type { Message } from '../../../../src/types.mts'
import {
  conversationFactory,
  conversationTranscript,
} from './fixture/model.mts'

it('rejects invalid system instructions and excess restored turns before creating sessions', async () => {
  const fixture = conversationFactory()
  await expect(
    createConversation(fixture.factory, {
      systemPrompt: 123,
    } as unknown as ConversationOptions),
  ).rejects.toBeInstanceOf(TypeError)
  const initialPrompts: Message[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'second reply' },
  ]
  await expect(
    createConversation(fixture.factory, { initialPrompts, maxTurns: 1 }),
  ).rejects.toMatchObject({ code: 'CONVERSATION_LIMIT' })
  const chat = await createConversation(fixture.factory)
  expect(() => chat.reset(123 as unknown as Message[])).toThrow(
    expect.objectContaining({ code: 'CONVERSATION_LIMIT' }),
  )
  expect(fixture.factory.create).not.toHaveBeenCalled()
  chat.destroy()
})

it.each([
  { maxTurns: 0 },
  { maxTurns: 1.5 },
  { maxTurns: Number.POSITIVE_INFINITY },
  { maxCharacters: 0 },
  { maxCharacters: Number.NaN },
  { maxCharacters: Number.MAX_SAFE_INTEGER + 1 },
])('rejects invalid bounds %j without creating a session', async options => {
  const fixture = conversationFactory()
  await expect(
    createConversation(fixture.factory, options),
  ).rejects.toBeInstanceOf(RangeError)
  expect(fixture.factory.create).not.toHaveBeenCalled()
})

it.each(
  [
    [{ role: 'user', content: 'unfinished' }],
    [{ role: 'assistant', content: 'unpaired' }],
    [
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
    ],
    [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '{', prefix: true },
    ],
    [{ role: 'unknown', content: 'invalid' }],
    [{ role: 'user', content: 5 }],
    [null],
  ].map(initialPrompts => ({ initialPrompts })),
)(
  'rejects incomplete or malformed restored history %j',
  async ({ initialPrompts }) => {
    const fixture = conversationFactory()
    await expect(
      createConversation(fixture.factory, {
        initialPrompts: initialPrompts as Message[],
      }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(fixture.factory.create).not.toHaveBeenCalled()
  },
)

it('counts restored turns and system characters toward finite limits', async () => {
  const fixture = conversationFactory()
  const initialPrompts = conversationTranscript()
  const chat = await createConversation(fixture.factory, {
    initialPrompts,
    maxTurns: 1,
  })
  await expect(chat.prompt('extra')).rejects.toMatchObject({
    code: 'CONVERSATION_LIMIT',
  })
  expect(fixture.factory.create).not.toHaveBeenCalled()
  await expect(
    createConversation(fixture.factory, { initialPrompts, maxCharacters: 3 }),
  ).rejects.toMatchObject({ code: 'CONVERSATION_LIMIT' })
  await expect(
    createConversation(fixture.factory, {
      initialPrompts,
      systemPrompt: 'conflicting',
    }),
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    createConversation(fixture.factory, {
      systemPrompt: 'long',
      maxCharacters: 3,
    }),
  ).rejects.toMatchObject({ code: 'CONVERSATION_LIMIT' })
  await expect(
    createConversation(fixture.factory, {
      initialPrompts: 'bad',
    } as unknown as ConversationOptions),
  ).rejects.toBeInstanceOf(TypeError)
  chat.destroy()
})

it('reserves queued turns and does not retain over-budget replies', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory, {
    maxTurns: 1,
    maxCharacters: 8,
  })
  const first = chat.prompt('ok')
  await expect(chat.prompt('queued')).rejects.toMatchObject({
    code: 'CONVERSATION_LIMIT',
  })
  await first
  expect(chat.messages()).toHaveLength(2)
  chat.reset([])
  await expect(chat.prompt('big')).rejects.toMatchObject({
    code: 'CONVERSATION_LIMIT',
  })
  expect(chat.messages()).toEqual([])
  expect(fixture.sessions[1]!.session.destroy).toHaveBeenCalledOnce()
  await expect(chat.prompt('123456789')).rejects.toMatchObject({
    code: 'CONVERSATION_LIMIT',
  })
  await expect(chat.prompt('   ')).rejects.toBeInstanceOf(TypeError)
  chat.destroy()
})

it('uses reset history defensively and retains the original reset seed', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory, {
    systemPrompt: 'seed',
  })
  await chat.prompt('first')
  const replacement = conversationTranscript('replacement')
  chat.reset(replacement)
  replacement[1]!.content = 'changed'
  expect(chat.messages()[1]!.content).toBe('replacement')
  expect(() => chat.reset([{ role: 'user', content: 'unfinished' }])).toThrow(
    TypeError,
  )
  expect(chat.messages()[1]!.content).toBe('replacement')
  chat.reset()
  expect(chat.messages()).toEqual([{ role: 'system', content: 'seed' }])
  chat.reset([])
  expect(chat.messages()).toEqual([])
  chat.destroy()
})
