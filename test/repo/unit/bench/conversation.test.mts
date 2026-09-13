import { afterEach, expect, it, vi } from 'vitest'
import { compareConversations } from '../../../../src/bench/conversation.mts'
import type {
  LanguageModelLike,
  Message,
  SessionLike,
} from '../../../../src/types.mts'

function createConversationFactory() {
  const calls: Message[][] = []
  const destroyed: SessionLike[] = []
  const sessions: SessionLike[] = []
  const factory: LanguageModelLike = {
    contextMode: 'native',
    availability: async () => 'available',
    async create(options) {
      const initial =
        (options as { initialPrompts?: Message[] } | undefined)
          ?.initialPrompts ?? []
      const history = initial.map(message => ({ ...message }))
      const session: SessionLike = {
        contextStatus: () => ({
          overflowed: false,
          contextUsage: history.length,
          contextWindow: 9216,
        }),
        destroy() {
          destroyed.push(session)
        },
        async prompt() {
          throw new Error('Expected streaming')
        },
        promptStreaming(messages) {
          calls.push(messages.map(message => ({ ...message })))
          history.push(...messages)
          const user = messages.at(-1)!.content
          const full = history.map(message => message.content).join('\n')
          const output = user.endsWith('Reply READY.')
            ? 'READY'
            : full.match(/ORCHID-\d+/)![0]
          history.push({ role: 'assistant', content: output })
          return new ReadableStream({
            start(controller) {
              controller.enqueue(output)
              controller.close()
            },
          })
        },
      }
      sessions.push(session)
      return session
    },
  }
  return { calls, destroyed, factory, sessions }
}

afterEach(() => {
  vi.useRealTimers()
})

it('compares native turns with replayed committed history and disposes every session', async () => {
  vi.useFakeTimers()
  const fixture = createConversationFactory()
  const report = await compareConversations(fixture.factory, {
    pairs: 2,
    contextLines: 2,
    timeoutMs: 100,
  })
  expect(report.samples).toHaveLength(12)
  expect(report.samples.every(sample => sample.ok)).toBe(true)
  expect(fixture.calls).toHaveLength(12)
  expect(fixture.sessions).toHaveLength(8)
  expect(new Set(fixture.destroyed)).toEqual(new Set(fixture.sessions))
  const followups = report.samples.filter(sample => sample.turn > 0)
  expect(
    followups
      .filter(sample => sample.mode === 'persistent')
      .every(sample => sample.inputCharacters < sample.contextCharacters),
  ).toBe(true)
  expect(
    followups
      .filter(sample => sample.mode === 'fresh')
      .every(sample => sample.inputCharacters === sample.contextCharacters),
  ).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('refuses to label a replay-only factory as persistent native context', async () => {
  const fixture = createConversationFactory()
  await expect(
    compareConversations(
      { ...fixture.factory, contextMode: 'replay' },
      {
        pairs: 1,
        contextLines: 0,
        timeoutMs: 100,
      },
    ),
  ).rejects.toBeInstanceOf(TypeError)
  expect(fixture.sessions).toHaveLength(0)
})

it('bounds stalled generation and releases the session', async () => {
  vi.useFakeTimers()
  const fixture = createConversationFactory()
  const create = fixture.factory.create.bind(fixture.factory)
  fixture.factory.create = async options => {
    const session = await create(options)
    session.promptStreaming = () => new ReadableStream()
    return session
  }
  const pending = compareConversations(fixture.factory, {
    pairs: 1,
    contextLines: 0,
    timeoutMs: 100,
  }).catch(error => error)
  await vi.advanceTimersByTimeAsync(100)
  expect(await pending).toMatchObject({ name: 'TimeoutError' })
  expect(new Set(fixture.destroyed)).toEqual(new Set(fixture.sessions))
  expect(vi.getTimerCount()).toBe(0)
})
