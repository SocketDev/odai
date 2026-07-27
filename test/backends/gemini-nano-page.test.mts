import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createPageBoundFactory,
  pageAvailability,
  pageCloneSession,
  pageCreateSession,
  pageDestroySession,
  pageKickDownload,
  pagePrompt,
  pagePromptStreaming,
  rethrowPageError,
  StreamQueue,
  stripUndefined,
  waitForModelReady,
} from '../../src/backends/gemini-nano-page.mts'
import type {
  Bridge,
  PageLike,
  StreamPayload,
} from '../../src/backends/gemini-nano-page.mts'
import type { SessionLike } from '../../src/types.mts'

type Holder = Record<string, unknown>

function holder(): Holder {
  return globalThis as unknown as Holder
}

function installStreamBinding(): StreamPayload[] {
  const collected: StreamPayload[] = []
  holder()['__odaiStreamChunk'] = async (payload: StreamPayload) => {
    collected.push(payload)
  }
  return collected
}

describe('page-proxy functions', () => {
  beforeEach(() => {
    delete holder()['LanguageModel']
    delete holder()['__odaiSessions']
    delete holder()['__odaiStreamChunk']
  })

  afterEach(() => {
    delete holder()['LanguageModel']
    delete holder()['__odaiSessions']
    delete holder()['__odaiStreamChunk']
  })

  describe('pageAvailability', () => {
    it('reports no-global when no LanguageModel exists', () => {
      expect(pageAvailability()).toBe('no-global')
    })

    it('delegates to the runtime availability call', async () => {
      holder()['LanguageModel'] = {
        availability: async () => 'available',
      }
      expect(await pageAvailability()).toBe('available')
    })
  })

  describe('pageCreateSession', () => {
    it('fails when the LanguageModel global is missing', async () => {
      const result = await pageCreateSession({ options: {}, sessionId: 1 })
      expect(result.ok).toBe(false)
      expect(result.error?.message).toContain('LanguageModel global missing')
    })

    it('stores a session and reports clone capability', async () => {
      holder()['LanguageModel'] = {
        create: async () => ({ clone: () => ({}), prompt: async () => 'x' }),
      }
      const result = await pageCreateSession({ options: {}, sessionId: 7 })
      expect(result.ok).toBe(true)
      expect(result.cloneCapable).toBe(true)
      expect((holder()['__odaiSessions'] as Map<number, unknown>).has(7)).toBe(
        true,
      )
    })

    it('surfaces a create error with its name', async () => {
      holder()['LanguageModel'] = {
        create: async () => {
          throw new TypeError('temperature is not supported')
        },
      }
      const result = await pageCreateSession({ options: {}, sessionId: 1 })
      expect(result.ok).toBe(false)
      expect(result.error).toEqual({
        message: 'temperature is not supported',
        name: 'TypeError',
      })
    })
  })

  describe('pagePrompt', () => {
    it('fails on an unknown session id', async () => {
      const result = await pagePrompt({ messages: [], sessionId: 99 })
      expect(result.ok).toBe(false)
      expect(result.error?.message).toBe('unknown session id')
    })

    it('returns the raw reply for a known session', async () => {
      holder()['LanguageModel'] = {
        create: async () => ({ prompt: async () => 'the reply' }),
      }
      await pageCreateSession({ options: {}, sessionId: 3 })
      const result = await pagePrompt({
        messages: [{ content: 'hi', role: 'user' }],
        sessionId: 3,
      })
      expect(result).toEqual({ ok: true, raw: 'the reply' })
    })

    it('surfaces a prompt error with its name', async () => {
      holder()['LanguageModel'] = {
        create: async () => ({
          prompt: async () => {
            const error = new Error('session busy')
            error.name = 'InvalidStateError'
            throw error
          },
        }),
      }
      await pageCreateSession({ options: {}, sessionId: 4 })
      const result = await pagePrompt({ messages: [], sessionId: 4 })
      expect(result.ok).toBe(false)
      expect(result.error).toEqual({
        message: 'session busy',
        name: 'InvalidStateError',
      })
    })
  })

  describe('pageCloneSession', () => {
    it('fails on an unknown session id', async () => {
      const result = await pageCloneSession({ cloneId: 2, sessionId: 1 })
      expect(result.ok).toBe(false)
      expect(result.error?.message).toBe('unknown session id')
    })

    it('rejects a session without a clone method', async () => {
      holder()['LanguageModel'] = {
        create: async () => ({ prompt: async () => 'x' }),
      }
      await pageCreateSession({ options: {}, sessionId: 5 })
      const result = await pageCloneSession({ cloneId: 6, sessionId: 5 })
      expect(result.ok).toBe(false)
      expect(result.error?.name).toBe('NotSupportedError')
    })

    it('clones a capable session under the new id', async () => {
      holder()['LanguageModel'] = {
        create: async () => ({
          clone: async () => ({ prompt: async () => 'cloned' }),
          prompt: async () => 'x',
        }),
      }
      await pageCreateSession({ options: {}, sessionId: 8 })
      const result = await pageCloneSession({ cloneId: 9, sessionId: 8 })
      expect(result.ok).toBe(true)
      expect((holder()['__odaiSessions'] as Map<number, unknown>).has(9)).toBe(
        true,
      )
    })

    it('surfaces a clone error with its name', async () => {
      holder()['LanguageModel'] = {
        create: async () => ({
          clone: async () => {
            const error = new Error('clone quota exceeded')
            error.name = 'QuotaExceededError'
            throw error
          },
          prompt: async () => 'x',
        }),
      }
      await pageCreateSession({ options: {}, sessionId: 10 })
      const result = await pageCloneSession({ cloneId: 11, sessionId: 10 })
      expect(result.ok).toBe(false)
      expect(result.error?.name).toBe('QuotaExceededError')
    })
  })

  describe('pageDestroySession', () => {
    it('destroys and removes a stored session', async () => {
      let destroyed = false
      holder()['LanguageModel'] = {
        create: async () => ({
          destroy: () => {
            destroyed = true
          },
          prompt: async () => 'x',
        }),
      }
      await pageCreateSession({ options: {}, sessionId: 12 })
      pageDestroySession({ sessionId: 12 })
      expect(destroyed).toBe(true)
      expect((holder()['__odaiSessions'] as Map<number, unknown>).has(12)).toBe(
        false,
      )
    })

    it('is a no-op for an unknown session id', () => {
      expect(() => pageDestroySession({ sessionId: 404 })).not.toThrow()
    })
  })

  describe('pageKickDownload', () => {
    it('reports no-global when no LanguageModel exists', async () => {
      expect(await pageKickDownload()).toBe('no-global')
    })

    it('reports created after a throwaway create-destroy', async () => {
      let destroyed = false
      holder()['LanguageModel'] = {
        create: async () => ({
          destroy: () => {
            destroyed = true
          },
        }),
      }
      expect(await pageKickDownload()).toBe('created')
      expect(destroyed).toBe(true)
    })

    it('reports the failure message when create throws', async () => {
      holder()['LanguageModel'] = {
        create: async () => {
          throw new Error('model still downloading')
        },
      }
      expect(await pageKickDownload()).toBe(
        'create failed: model still downloading',
      )
    })
  })

  describe('pagePromptStreaming', () => {
    it('emits an error for an unknown session id', async () => {
      const collected = installStreamBinding()
      await pagePromptStreaming({ messages: [], sessionId: 1, streamId: 1 })
      expect(collected).toEqual([{ error: 'unknown session id', streamId: 1 }])
    })

    it('pumps an async-iterable stream then a done marker', async () => {
      const collected = installStreamBinding()
      holder()['LanguageModel'] = {
        create: async () => ({
          promptStreaming: () =>
            (async function* generate(): AsyncGenerator<string> {
              yield 'a'
              yield 'b'
            })(),
          prompt: async () => 'x',
        }),
      }
      await pageCreateSession({ options: {}, sessionId: 20 })
      await pagePromptStreaming({ messages: [], sessionId: 20, streamId: 5 })
      expect(collected).toEqual([
        { chunk: 'a', streamId: 5 },
        { chunk: 'b', streamId: 5 },
        { done: true, streamId: 5 },
      ])
    })

    it('pumps a ReadableStream then a done marker', async () => {
      const collected = installStreamBinding()
      holder()['LanguageModel'] = {
        create: async () => ({
          promptStreaming: () =>
            new ReadableStream<string>({
              start(controller): void {
                controller.enqueue('x')
                controller.enqueue('y')
                controller.close()
              },
            }),
          prompt: async () => 'x',
        }),
      }
      await pageCreateSession({ options: {}, sessionId: 21 })
      await pagePromptStreaming({ messages: [], sessionId: 21, streamId: 6 })
      expect(collected).toEqual([
        { chunk: 'x', streamId: 6 },
        { chunk: 'y', streamId: 6 },
        { done: true, streamId: 6 },
      ])
    })

    it('emits an error payload when the stream throws', async () => {
      const collected = installStreamBinding()
      holder()['LanguageModel'] = {
        create: async () => ({
          promptStreaming: (): AsyncIterable<string> => ({
            [Symbol.asyncIterator]() {
              return {
                next(): Promise<IteratorResult<string>> {
                  return Promise.reject(new Error('stream broke'))
                },
              }
            },
          }),
          prompt: async () => 'x',
        }),
      }
      await pageCreateSession({ options: {}, sessionId: 22 })
      await pagePromptStreaming({ messages: [], sessionId: 22, streamId: 7 })
      expect(collected).toEqual([{ error: 'stream broke', streamId: 7 }])
    })

    it('drops chunks gracefully when no stream binding is installed', async () => {
      holder()['LanguageModel'] = {
        create: async () => ({
          promptStreaming: () =>
            (async function* generate(): AsyncGenerator<string> {
              yield 'ignored'
            })(),
          prompt: async () => 'x',
        }),
      }
      await pageCreateSession({ options: {}, sessionId: 23 })
      await expect(
        pagePromptStreaming({ messages: [], sessionId: 23, streamId: 8 }),
      ).resolves.toBeUndefined()
    })
  })

  describe('rethrowPageError', () => {
    it('rebuilds an error preserving the page name and message', () => {
      expect(() =>
        rethrowPageError({ message: 'boom', name: 'TypeError' }),
      ).toThrow(expect.objectContaining({ message: 'boom', name: 'TypeError' }))
    })

    it('falls back to a generic error when no shape is given', () => {
      expect(() => rethrowPageError(undefined)).toThrow(
        /gemini-nano-headless page error/,
      )
    })
  })

  describe('stripUndefined', () => {
    it('drops undefined values and keeps defined ones', () => {
      expect(stripUndefined({ a: 1, b: undefined, c: 'keep' })).toEqual({
        a: 1,
        c: 'keep',
      })
    })
  })

  describe('StreamQueue', () => {
    it('delivers a payload pushed before next is awaited', async () => {
      const queue = new StreamQueue()
      queue.push({ chunk: 'buffered', streamId: 1 })
      expect(await queue.next()).toEqual({ chunk: 'buffered', streamId: 1 })
    })

    it('resolves a pending next when a payload arrives', async () => {
      const queue = new StreamQueue()
      const pending = queue.next()
      queue.push({ done: true, streamId: 2 })
      expect(await pending).toEqual({ done: true, streamId: 2 })
    })
  })
})

describe('createPageBoundFactory', () => {
  function fakeBridge(): Bridge {
    const streams = new Map()
    const page: PageLike = {
      async evaluate<T>(fn: unknown, arg?: unknown | undefined): Promise<T> {
        return (await (fn as (value: unknown) => unknown)(arg)) as T
      },
      async exposeFunction(): Promise<unknown> {
        return undefined
      },
      async goto(): Promise<unknown> {
        return undefined
      },
    }
    return { close: async () => undefined, page, streams }
  }

  it('reports availability, prompts, clones, and destroys through the page', async () => {
    const bridge = fakeBridge()
    ;(globalThis as unknown as Holder)['__odaiStreamChunk'] = async (
      payload: StreamPayload,
    ) => {
      bridge.streams.get(payload.streamId)?.push(payload)
    }
    ;(globalThis as unknown as Holder)['LanguageModel'] = {
      availability: async () => 'available',
      create: async () => ({
        clone: async () => ({ prompt: async () => 'cloned reply' }),
        destroy: () => undefined,
        prompt: async () => 'direct reply',
        promptStreaming: () =>
          (async function* generate(): AsyncGenerator<string> {
            yield 'streamed'
          })(),
      }),
    }
    try {
      const factory = createPageBoundFactory(bridge)
      expect(await factory.availability()).toBe('available')
      const session: SessionLike = await factory.create({ temperature: 0 })
      expect(await session.prompt([{ content: 'hi', role: 'user' }])).toBe(
        'direct reply',
      )
      const cloned = await session.clone!()
      expect(await cloned.prompt([{ content: 'hi', role: 'user' }])).toBe(
        'cloned reply',
      )
      const chunks: string[] = []
      for await (const chunk of session.promptStreaming!([
        { content: 'go', role: 'user' },
      ]) as AsyncIterable<string>) {
        chunks.push(chunk)
      }
      expect(chunks).toEqual(['streamed'])
      session.destroy!()
    } finally {
      delete (globalThis as unknown as Holder)['LanguageModel']
      delete (globalThis as unknown as Holder)['__odaiSessions']
      delete (globalThis as unknown as Holder)['__odaiStreamChunk']
    }
  })
})

describe('waitForModelReady', () => {
  it('returns as soon as the page reports available', async () => {
    const page: PageLike = {
      async evaluate<T>(): Promise<T> {
        return 'available' as T
      },
      async exposeFunction(): Promise<unknown> {
        return undefined
      },
      async goto(): Promise<unknown> {
        return undefined
      },
    }
    await expect(
      waitForModelReady(page, { allowDownload: false, userDataDir: '/tmp/x' }),
    ).resolves.toBeUndefined()
  })

  it('throws a Chrome-remedy error when the page exposes no global', async () => {
    const page: PageLike = {
      async evaluate<T>(): Promise<T> {
        return 'no-global' as T
      },
      async exposeFunction(): Promise<unknown> {
        return undefined
      },
      async goto(): Promise<unknown> {
        return undefined
      },
    }
    await expect(
      waitForModelReady(page, { allowDownload: false, userDataDir: '/tmp/x' }),
    ).rejects.toThrow(/no LanguageModel global/)
  })

  it('kicks a download then times out with the last state', async () => {
    const kicks: unknown[] = []
    const page: PageLike = {
      async evaluate<T>(fn: unknown): Promise<T> {
        // The kick evaluation returns a string too; record it and keep the
        // availability probe pinned at downloadable so the loop times out.
        if (kicks.length > 0 && fn !== undefined) {
          /* no-op */
        }
        kicks.push(fn)
        return 'downloadable' as T
      },
      async exposeFunction(): Promise<unknown> {
        return undefined
      },
      async goto(): Promise<unknown> {
        return undefined
      },
    }
    await expect(
      waitForModelReady(page, {
        allowDownload: true,
        readyTimeoutMs: 30,
        userDataDir: '/tmp/x',
      }),
    ).rejects.toThrow(/did not become available.*downloadable/s)
    // The download kick fired at least once alongside the availability polls.
    expect(kicks.length).toBeGreaterThan(1)
  })
})
