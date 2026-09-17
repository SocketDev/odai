import { afterEach, expect, it, vi } from 'vitest'

import {
  pageBeginOperation,
  pageCancelOperation,
} from '../../../../../src/backends/chrome-page/operations.mts'
import {
  pagePrompt,
  pagePromptStreaming,
} from '../../../../../src/backends/chrome-page/prompt.mts'
import { StreamQueue } from '../../../../../src/backends/chrome-page/queue.mts'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('rejects prompt and stream requests whose operations were cancelled before dispatch', async () => {
  const prompt = vi.fn()
  const promptStreaming = vi.fn()
  const emit = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('__odaiSessions', new Map([[1, { prompt, promptStreaming }]]))
  vi.stubGlobal('__odaiOperations', new Map())
  vi.stubGlobal('__odaiStreamChunk', emit)
  await expect(
    pagePrompt({ messages: [], operationId: 2, sessionId: 1 }),
  ).resolves.toMatchObject({ ok: false, error: { name: 'AbortError' } })
  await pagePromptStreaming({
    messages: [],
    operationId: 2,
    sessionId: 1,
    streamId: 3,
  })
  expect(emit).toHaveBeenCalledWith({
    error: 'operation cancelled',
    streamId: 3,
  })
  expect(prompt).not.toHaveBeenCalled()
  expect(promptStreaming).not.toHaveBeenCalled()
})

it('handles cancellation raised synchronously by the native prompt before its listener is attached', async () => {
  const controller = new AbortController()
  vi.stubGlobal(
    '__odaiSessions',
    new Map([
      [
        1,
        {
          prompt: () => {
            controller.abort()
            return Promise.resolve('ignored reply')
          },
        },
      ],
    ]),
  )
  vi.stubGlobal(
    '__odaiOperations',
    new Map([[2, { controller, sessionId: 1 }]]),
  )
  await expect(
    pagePrompt({ messages: [], operationId: 2, sessionId: 1 }),
  ).resolves.toMatchObject({ ok: false, error: { name: 'AbortError' } })
})

it('closes a stream cancelled synchronously during native stream creation without reading it', async () => {
  const controller = new AbortController()
  const next = vi.fn()
  const returning = vi.fn().mockResolvedValue({ done: true })
  vi.stubGlobal(
    '__odaiSessions',
    new Map([
      [
        1,
        {
          promptStreaming: () => {
            controller.abort()
            return {
              [Symbol.asyncIterator]: () => ({ next, return: returning }),
            }
          },
        },
      ],
    ]),
  )
  vi.stubGlobal(
    '__odaiOperations',
    new Map([[2, { controller, sessionId: 1 }]]),
  )
  const emit = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('__odaiStreamChunk', emit)
  await pagePromptStreaming({
    messages: [],
    operationId: 2,
    sessionId: 1,
    streamId: 3,
  })
  expect(next).not.toHaveBeenCalled()
  expect(returning).toHaveBeenCalledOnce()
  expect(emit).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.any(String) }),
  )
})

it('reports a failed native read and absorbs rejection from iterator cleanup', async () => {
  const returning = vi
    .fn()
    .mockRejectedValue(new Error('iterator cleanup failed'))
  const next = vi.fn().mockRejectedValue(new Error('native read failed'))
  const controller = new AbortController()
  vi.stubGlobal(
    '__odaiSessions',
    new Map([
      [
        1,
        {
          promptStreaming: () => ({
            [Symbol.asyncIterator]: () => ({ next, return: returning }),
          }),
        },
      ],
    ]),
  )
  vi.stubGlobal(
    '__odaiOperations',
    new Map([[2, { controller, sessionId: 1 }]]),
  )
  const emit = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('__odaiStreamChunk', emit)
  await pagePromptStreaming({
    messages: [],
    operationId: 2,
    sessionId: 1,
    streamId: 3,
  })
  expect(returning).toHaveBeenCalledOnce()
  expect(emit).toHaveBeenCalledWith({
    error: 'native read failed',
    streamId: 3,
  })
})

it('settles a page prompt after cancellation even when the native promise stays pending', async () => {
  const prompt = vi.fn().mockReturnValue(new Promise(() => {}))
  const operations = new Map()
  vi.stubGlobal('__odaiSessions', new Map([[1, { prompt }]]))
  vi.stubGlobal('__odaiOperations', operations)
  pageBeginOperation({ operationId: 2, sessionId: 1 })
  const result = pagePrompt({ messages: [], operationId: 2, sessionId: 1 })
  pageCancelOperation({ operationId: 2 })
  await expect(result).resolves.toMatchObject({
    ok: false,
    error: { name: 'AbortError' },
  })
  expect(prompt).toHaveBeenCalledOnce()
  expect(operations.size).toBe(0)
})

it('closes an async iterator once when cancellation interrupts a pending native read', async () => {
  const returning = vi.fn().mockResolvedValue({ done: true, value: undefined })
  const next = vi.fn().mockReturnValue(new Promise(() => {}))
  const nativeStream = {
    [Symbol.asyncIterator]: () => ({ next, return: returning }),
  }
  const operations = new Map()
  vi.stubGlobal(
    '__odaiSessions',
    new Map([[1, { promptStreaming: () => nativeStream }]]),
  )
  vi.stubGlobal('__odaiOperations', operations)
  vi.stubGlobal('__odaiStreamChunk', async () => undefined)
  pageBeginOperation({ operationId: 2, sessionId: 1 })
  const result = pagePromptStreaming({
    messages: [],
    operationId: 2,
    sessionId: 1,
    streamId: 3,
  })
  await vi.waitFor(() => {
    expect(next).toHaveBeenCalledOnce()
  })
  pageCancelOperation({ operationId: 2 })
  await result
  expect(returning).toHaveBeenCalledOnce()
  expect(operations.size).toBe(0)
})

it('settles all queue waiters and discards buffered chunks on close', async () => {
  const queue = new StreamQueue()
  const first = queue.next()
  const second = queue.next()
  const terminal = { done: true, streamId: 1 }
  queue.close(terminal)
  expect(await Promise.all([first, second])).toEqual([terminal, terminal])
  queue.push({ chunk: 'late chunk', streamId: 1 })
  expect(await queue.next()).toEqual(terminal)
  const buffered = new StreamQueue()
  buffered.push({ chunk: 'unused chunk', streamId: 1 })
  buffered.push(terminal)
  buffered.close(terminal)
  expect(await buffered.next()).toEqual(terminal)
  const completed = new StreamQueue()
  const readers = [completed.next(), completed.next()]
  completed.push(terminal)
  expect(await Promise.all(readers)).toEqual([terminal, terminal])
})
