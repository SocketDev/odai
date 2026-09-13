import { describe, expect, it, vi } from 'vitest'

import {
  isReadableStream,
  mergeChunks,
  readChunks,
  streamPrompt,
  tryExtractEarlyField,
} from '../src/stream.mts'
import type { Message, SessionLike } from '../src/types.mts'

function createDeferredValue<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, reject, resolve }
}

function createSession(chunks: string[]): SessionLike {
  return {
    prompt(): Promise<string> {
      return Promise.resolve(chunks.join(''))
    },
    promptStreaming(): AsyncIterable<string> {
      return (async function* generate(): AsyncGenerator<string> {
        for (let i = 0, { length } = chunks; i < length; i += 1) {
          yield chunks[i]!
        }
      })()
    },
  }
}

describe('stream', () => {
  it.each([false, true])(
    'discards a settled read when abort wins before consumption (done: %s)',
    async done => {
      const controller = new AbortController()
      const chunk = createDeferredValue<IteratorResult<string>>()
      const closeIterator = vi.fn(async () => ({
        done: true as const,
        value: undefined,
      }))
      const iterator: AsyncIterableIterator<string> = {
        [Symbol.asyncIterator]() {
          return this
        },
        next() {
          void chunk.promise.then(() => {
            queueMicrotask(() => controller.abort())
          })
          return chunk.promise
        },
        return: closeIterator,
      }
      const session = createSession([])
      session.promptStreaming = () => iterator
      const onEarlyField = vi.fn()
      const pending = streamPrompt(session, [], {
        abortSignal: controller.signal,
        earlyFieldPatterns: { ready: /"ready":(?<value>true)/ },
        onEarlyField,
      })
      chunk.resolve(
        done
          ? { done: true, value: undefined }
          : { done: false, value: '{"ready":true}' },
      )
      expect(await pending).toMatchObject({ aborted: true, raw: '' })
      expect(onEarlyField).not.toHaveBeenCalled()
      expect(closeIterator).toHaveBeenCalledTimes(1)
    },
  )

  it('reports the first field before the stream finishes and only once', async () => {
    const waiting = createDeferredValue<void>()
    const finish = createDeferredValue<IteratorResult<string>>()
    let reads = 0
    const iterator: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        reads += 1
        if (reads === 1) {
          return Promise.resolve({ done: false, value: '{"ready":true}' })
        }
        if (reads === 2) {
          return Promise.resolve({
            done: false,
            value: '{"ready":true,"details":"finished"}',
          })
        }
        waiting.resolve()
        return finish.promise
      },
    }
    const session = createSession([])
    session.promptStreaming = () => iterator
    const onEarlyField = vi.fn()
    const pending = streamPrompt(session, [], {
      earlyFieldPatterns: { ready: /"ready":(?<value>true)/ },
      onEarlyField,
    })
    await waiting.promise
    try {
      expect(onEarlyField).toHaveBeenCalledExactlyOnceWith({
        name: 'ready',
        raw: '{"ready":true}',
        value: true,
      })
    } finally {
      finish.resolve({ done: true, value: undefined })
      await pending
    }
    expect(onEarlyField).toHaveBeenCalledTimes(1)
  })

  it('normalizes cumulative chunks', async () => {
    const session = createSession(['hello', 'hello world', 'hello world!'])
    const result = await streamPrompt(session, [
      { content: 'hi', role: 'user' },
    ])
    expect(result.raw).toBe('hello world!')
  })

  it('normalizes delta chunks', async () => {
    const session = createSession(['hello ', 'world', '!'])
    const result = await streamPrompt(session, [
      { content: 'hi', role: 'user' },
    ])
    expect(result.raw).toBe('hello world!')
  })

  it('falls back to prompt when streaming is unavailable', async () => {
    // Deliberately out of contract: `SessionLike` requires `promptStreaming`,
    // and this asserts the fallback for a runtime session that omits it anyway
    // (an older browser build, a hand-rolled backend).
    const session = {
      async prompt(messages: Message[]): Promise<string> {
        void messages
        return 'plain'
      },
    } as unknown as SessionLike
    const result = await streamPrompt(session, [
      { content: 'hi', role: 'user' },
    ])
    expect(result.raw).toBe('plain')
  })

  it('extracts early field', async () => {
    const session = createSession(['{"sentiment":"positive"}'])
    let captured: unknown
    await streamPrompt(session, [{ content: 'hi', role: 'user' }], {
      earlyFieldPatterns: { sentiment: /"sentiment":"(?<value>[^"]+)"/ },
      onEarlyField(field): void {
        captured = field.value
      },
    })
    expect(captured).toBe('positive')
  })

  it('returns an aborted result without prompting when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const session = createSession(['unused'])
    const result = await streamPrompt(
      session,
      [{ content: 'hi', role: 'user' }],
      { abortSignal: controller.signal },
    )
    expect(result.aborted).toBe(true)
    expect(result.raw).toBe('')
  })

  it('does not call onEarlyField when no pattern matches', async () => {
    const session = createSession(['{"other":"value"}'])
    let called = false
    await streamPrompt(session, [{ content: 'hi', role: 'user' }], {
      earlyFieldPatterns: { sentiment: /"sentiment":"(?<value>[^"]+)"/ },
      onEarlyField(): void {
        called = true
      },
    })
    expect(called).toBe(false)
  })

  it('reads a ReadableStream returned by promptStreaming', async () => {
    const stream = new ReadableStream<string>({
      start(controller): void {
        controller.enqueue('hello ')
        controller.enqueue('world')
        controller.close()
      },
    })
    const session: SessionLike = {
      async prompt(): Promise<string> {
        return 'unused'
      },
      promptStreaming(): ReadableStream<string> {
        return stream
      },
    }
    const result = await streamPrompt(session, [
      { content: 'hi', role: 'user' },
    ])
    expect(result.raw).toBe('hello world')
    expect(stream.locked).toBe(false)
  })

  it('cancels a pending reader and returns partial output without waiting for cleanup', async () => {
    const controller = new AbortController()
    const observed = createDeferredValue<void>()
    const cleanup = createDeferredValue<void>()
    const cancel = vi.fn(() => cleanup.promise)
    const stream = new ReadableStream<string>({
      cancel,
      start(source) {
        source.enqueue('{"ready":true}')
      },
    })
    const session = createSession([])
    session.promptStreaming = () => stream
    const destroy = vi.fn()
    session.destroy = destroy
    const pending = streamPrompt(session, [], {
      abortSignal: controller.signal,
      earlyFieldPatterns: { ready: /"ready":(?<value>true)/ },
      onEarlyField: () => observed.resolve(),
      requestId: 'reader-request',
    })
    await observed.promise
    expect(stream.locked).toBe(true)
    const reason = new Error('Reader cancelled')
    controller.abort(reason)
    expect(await pending).toEqual({
      aborted: true,
      raw: '{"ready":true}',
      requestId: 'reader-request',
      stale: false,
    })
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason)
    expect(stream.locked).toBe(false)
    expect(destroy).not.toHaveBeenCalled()
    cleanup.reject(new Error('Late cancellation failure'))
  })

  it('requests iterator cleanup and removes its abort listener without waiting for pending work', async () => {
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const reading = createDeferredValue<void>()
    const nextValue = createDeferredValue<IteratorResult<string>>()
    const cleanup = createDeferredValue<IteratorResult<string>>()
    const closeIterator = vi.fn(() => cleanup.promise)
    const iterator: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        reading.resolve()
        return nextValue.promise
      },
      return: closeIterator,
    }
    const session = createSession([])
    session.promptStreaming = () => iterator
    const pending = streamPrompt(session, [], {
      abortSignal: controller.signal,
    })
    await reading.promise
    controller.abort()
    expect(await pending).toMatchObject({ aborted: true, raw: '' })
    expect(closeIterator).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledWith(
      'abort',
      addListener.mock.calls[0]![1],
    )
    nextValue.reject(new Error('Late read failure'))
    cleanup.reject(new Error('Late iterator cleanup failure'))
  })

  it('preserves a reader error and releases its lock', async () => {
    const failure = new Error('Generation failed')
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.error(failure)
      },
    })
    const session = createSession([])
    session.promptStreaming = () => stream
    await expect(streamPrompt(session, [])).rejects.toBe(failure)
    expect(stream.locked).toBe(false)
  })

  it('preserves an iterator error when cleanup throws', async () => {
    const failure = new Error('Iterator failed')
    const iterator: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () => Promise.reject(failure),
      return() {
        throw new Error('Iterator cleanup failed')
      },
    }
    const session = createSession([])
    session.promptStreaming = () => iterator
    await expect(streamPrompt(session, [])).rejects.toBe(failure)
  })

  it('releases and cancels the reader when the early callback throws', async () => {
    const failure = new Error('Callback failed')
    const cancel = vi.fn()
    const stream = new ReadableStream<string>({
      cancel,
      start(source) {
        source.enqueue('{"ready":true}')
      },
    })
    const session = createSession([])
    session.promptStreaming = () => stream
    await expect(
      streamPrompt(session, [], {
        earlyFieldPatterns: { ready: /"ready":(?<value>true)/ },
        onEarlyField() {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(stream.locked).toBe(false)
  })

  it('returns an aborted result before invoking the non-streaming fallback', async () => {
    const prompt = vi.fn()
    const session = { prompt } as unknown as SessionLike
    const controller = new AbortController()
    controller.abort()
    expect(
      await streamPrompt(session, [], { abortSignal: controller.signal }),
    ).toMatchObject({ aborted: true, raw: '' })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('stops waiting for an aborted fallback and consumes its late rejection', async () => {
    const response = createDeferredValue<string>()
    const prompt = vi.fn(() => response.promise)
    const session = { prompt } as unknown as SessionLike
    const controller = new AbortController()
    const pending = streamPrompt(session, [], {
      abortSignal: controller.signal,
    })
    controller.abort()
    expect(await pending).toMatchObject({ aborted: true, raw: '' })
    expect(prompt).toHaveBeenCalledWith([], {
      abortSignal: controller.signal,
    })
    response.reject(new Error('Late fallback failure'))
  })

  it('discards a settled fallback when abort wins before consumption', async () => {
    const response = createDeferredValue<string>()
    const controller = new AbortController()
    const session = {
      prompt() {
        void response.promise.then(() => {
          queueMicrotask(() => controller.abort())
        })
        return response.promise
      },
    } as unknown as SessionLike
    const pending = streamPrompt(session, [], {
      abortSignal: controller.signal,
    })
    response.resolve('late result')
    expect(await pending).toMatchObject({ aborted: true, raw: '' })
  })
})

describe('isReadableStream', () => {
  it('recognizes a real ReadableStream and rejects other values', () => {
    expect(isReadableStream(new ReadableStream())).toBe(true)
    expect(isReadableStream(undefined)).toBe(false)
    // A JSON-parsed null is a real runtime input the guard screens for.
    expect(isReadableStream(JSON.parse('null'))).toBe(false)
    expect(isReadableStream({})).toBe(false)
  })
})

describe('mergeChunks', () => {
  it('keeps the longest cumulative prefix', () => {
    expect(mergeChunks(['ab', 'abc', 'abcd'])).toBe('abcd')
  })

  it('concatenates non-prefix deltas', () => {
    expect(mergeChunks(['ab', 'cd', 'ef'])).toBe('abcdef')
  })
})

describe('readChunks', () => {
  it('drains an async iterable', async () => {
    const iterable = (async function* generate(): AsyncGenerator<string> {
      yield 'a'
      yield 'b'
    })()
    expect(await readChunks(iterable)).toEqual(['a', 'b'])
  })

  it('preserves individual readable chunks and releases the reader', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('first')
        controller.enqueue('second')
        controller.close()
      },
    })
    expect(await readChunks(stream)).toEqual(['first', 'second'])
    expect(stream.locked).toBe(false)
  })
})

describe('tryExtractEarlyField', () => {
  it('parses a JSON-valued capture group', () => {
    expect(tryExtractEarlyField('{"n":42}', { n: /"n":(?<n>\d+)/ })).toEqual({
      name: 'n',
      value: 42,
    })
  })

  it('falls back to the raw capture when it is not valid JSON', () => {
    expect(
      tryExtractEarlyField('{"s":"hi"}', { s: /"s":"(?<s>[^"]+)/ }),
    ).toEqual({
      name: 's',
      value: 'hi',
    })
  })

  it('returns undefined when nothing matches', () => {
    expect(
      tryExtractEarlyField('nope', { s: /"s":"(?<s>[^"]+)"/ }),
    ).toBeUndefined()
  })
})
