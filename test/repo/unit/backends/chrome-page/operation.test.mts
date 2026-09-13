import { afterEach, expect, it, vi } from 'vitest'

import { createPageOperation } from '../../../../../src/backends/chrome-page/operation.mts'
import { pageBeginOperation } from '../../../../../src/backends/chrome-page/operations.mts'
import type {
  PageLike,
  PageResult,
} from '../../../../../src/backends/chrome-page/types.mts'

afterEach(() => {
  vi.unstubAllGlobals()
})

export function operationPageFixture(
  evaluate: (fn: unknown) => Promise<unknown>,
): PageLike {
  return {
    async evaluate<T>(fn: unknown): Promise<T> {
      return (await evaluate(fn)) as T
    },
    exposeFunction: async () => undefined,
    goto: async () => undefined,
  }
}

it('rejects an already cancelled operation before dispatch and ignores repeated cancellation', async () => {
  const controller = new AbortController()
  const reason = new Error('cancel before dispatch')
  controller.abort(reason)
  const evaluate = vi.fn()
  const invoke = vi.fn()
  const operation = createPageOperation(
    operationPageFixture(evaluate),
    { operationId: 1, sessionId: 2 },
    invoke,
    controller.signal,
  )
  await expect(operation.promise).rejects.toBe(reason)
  operation.cancel(new Error('second cancellation'))
  expect(evaluate).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
})

it('ignores cancellation after a successful operation', async () => {
  const evaluate = vi.fn().mockResolvedValue({ ok: true })
  const operation = createPageOperation(
    operationPageFixture(evaluate),
    { operationId: 1, sessionId: 2 },
    async () => 'reply',
  )
  await expect(operation.promise).resolves.toBe('reply')
  operation.cancel(new Error('late cancellation'))
  expect(evaluate).toHaveBeenCalledOnce()
})

it('preserves cancellation when browser cleanup fails after delayed registration', async () => {
  const registration = Promise.withResolvers<PageResult>()
  const evaluate = vi.fn((fn: unknown) =>
    fn === pageBeginOperation
      ? registration.promise
      : Promise.reject(new Error('page closed during cleanup')),
  )
  const invoke = vi.fn()
  const operation = createPageOperation(
    operationPageFixture(evaluate),
    { operationId: 1, sessionId: 2 },
    invoke,
  )
  const reason = new Error('cancel registration')
  operation.cancel(reason)
  await expect(operation.promise).rejects.toBe(reason)
  registration.resolve({ ok: true })
  await vi.waitFor(() => {
    expect(evaluate).toHaveBeenCalledTimes(2)
  })
  expect(invoke).not.toHaveBeenCalled()
})

it('preserves a native failure when browser operation cleanup also rejects', async () => {
  const evaluate = vi.fn((fn: unknown) =>
    fn === pageBeginOperation
      ? Promise.resolve({ ok: true })
      : Promise.reject(new Error('cleanup channel closed')),
  )
  const reason = new Error('native operation failed')
  const operation = createPageOperation(
    operationPageFixture(evaluate),
    { operationId: 1, sessionId: 2 },
    async () => {
      throw reason
    },
  )
  await expect(operation.promise).rejects.toBe(reason)
  await vi.waitFor(() => {
    expect(evaluate).toHaveBeenCalledTimes(2)
  })
})

it('rejects registration for an unknown browser session without retaining an operation', () => {
  const operations = new Map()
  vi.stubGlobal('__odaiOperations', operations)
  vi.stubGlobal('__odaiSessions', new Map())
  expect(pageBeginOperation({ operationId: 1, sessionId: 2 })).toMatchObject({
    ok: false,
    error: { name: 'NotFoundError' },
  })
  expect(operations.size).toBe(0)
})
