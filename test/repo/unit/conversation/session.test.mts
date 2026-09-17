import { expect, it, vi } from 'vitest'
import { createConversation } from '../../../../src/conversation/create.mts'
import { runConversationTurn } from '../../../../src/conversation/session.mts'
import {
  createConversationState,
  destroyConversationState,
} from '../../../../src/conversation/state.mts'
import type { SessionContextStatus } from '../../../../src/types.mts'
import { conversationFactory } from './fixture/model.mts'

it('preserves a factory rejection and can retry without any committed failed turn', async () => {
  const fixture = conversationFactory()
  const reason = new Error('session creation failed')
  vi.spyOn(fixture.factory, 'create').mockRejectedValueOnce(reason)
  const chat = await createConversation(fixture.factory)
  await expect(chat.prompt('failed')).rejects.toBe(reason)
  expect(chat.messages()).toEqual([])
  await expect(chat.prompt('retry')).resolves.toBe('answer')
  expect(fixture.calls).toEqual([[{ role: 'user', content: 'retry' }]])
  chat.destroy()
})

it('guards the execution layer from generating beyond the restored turn limit', async () => {
  const fixture = conversationFactory()
  const state = createConversationState(fixture.factory, {
    initialPrompts: [
      { role: 'user', content: 'saved' },
      { role: 'assistant', content: 'reply' },
    ],
    maxTurns: 1,
  })
  const generate = vi.fn(async () => ({
    commit: true,
    raw: 'unexpected',
    value: 'unexpected',
  }))
  await expect(
    runConversationTurn(
      state,
      { generation: state.generation, signal: state.controller.signal },
      'excess',
      generate,
    ),
  ).rejects.toMatchObject({ code: 'CONVERSATION_LIMIT' })
  expect(fixture.factory.create).not.toHaveBeenCalled()
  expect(generate).not.toHaveBeenCalled()
  expect(state.messages).toHaveLength(2)
  destroyConversationState(state)
})

it.each([
  null,
  {},
  { overflowed: 'unknown' },
  { overflowed: false, contextUsage: Number.NaN },
  { overflowed: false, contextUsage: -1 },
  { overflowed: false, contextWindow: Number.POSITIVE_INFINITY },
])(
  'rejects invalid native status %j and disposes uncertain history',
  async status => {
    const fixture = conversationFactory()
    const chat = await createConversation(fixture.factory)
    await chat.prompt('saved')
    const committed = chat.messages()
    fixture.sessions[0]!.session.contextStatus = () =>
      status as SessionContextStatus
    await expect(chat.contextStatus()).rejects.toMatchObject({
      code: 'CONVERSATION_CONTEXT',
    })
    expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
    expect(chat.messages()).toEqual(committed)
    await chat.prompt('rebuilt')
    expect(fixture.sessions[1]!.initial).toEqual(committed)
    chat.destroy()
  },
)
