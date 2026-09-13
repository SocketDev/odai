import { afterEach, expect, it, vi } from 'vitest'
import { createBuiltinConversation } from '../../../../src/conversation/builtin.mts'
import { conversationFactory } from './fixture/model.mts'

const mocks = vi.hoisted(() => ({ getLanguageModel: vi.fn() }))
vi.mock('../../../../src/builtin-availability.mts', () => mocks)

afterEach(() => {
  vi.resetAllMocks()
})

it('uses the builtin capability directly and never probes model identity', async () => {
  const fixture = conversationFactory()
  mocks.getLanguageModel.mockReturnValue(fixture.factory)
  const chat = await createBuiltinConversation({ systemPrompt: 'instruction' })
  expect(fixture.factory.create).not.toHaveBeenCalled()
  await chat.prompt('user')
  expect(fixture.calls).toEqual([[{ role: 'user', content: 'user' }]])
  expect(fixture.sessions[0]!.initial).toEqual([
    { role: 'system', content: 'instruction' },
  ])
  chat.destroy()
})

it('fails before session creation when no builtin is available', async () => {
  mocks.getLanguageModel.mockReturnValue(undefined)
  await expect(createBuiltinConversation()).rejects.toBeInstanceOf(Error)
})

it('does not upgrade an unknown builtin factory to native context', async () => {
  const fixture = conversationFactory('replay')
  mocks.getLanguageModel.mockReturnValue({
    ...fixture.factory,
    contextMode: undefined,
  })
  const chat = await createBuiltinConversation()
  await chat.prompt('one')
  await chat.prompt('two')
  expect(await chat.contextStatus()).toMatchObject({ mode: 'replay' })
  expect(fixture.sessions).toHaveLength(2)
  chat.destroy()
})
