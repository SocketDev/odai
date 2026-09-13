import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  pageBeginOperation,
  pageCancelOperation,
} from '../../../../../src/backends/chrome-page/operations.mts'
import {
  pageCloneSession,
  pageContextStatus,
  pageCreateSession,
} from '../../../../../src/backends/chrome-page/sessions.mts'
import type { NativeChromeSession } from '../../../../../src/backends/chrome/native.mts'
import type { PageGlobalState } from '../../../../../src/backends/chrome-page/types.mts'

beforeEach(() => {
  vi.stubGlobal('__odaiSessions', new Map())
  vi.stubGlobal('__odaiContexts', new Map())
  vi.stubGlobal('__odaiOperations', new Map())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

it('tracks overflow in a cloned browser session independently of its source', async () => {
  const target = new EventTarget()
  const clone = { addEventListener: target.addEventListener.bind(target) }
  vi.stubGlobal('LanguageModel', {
    create: async () => ({ clone: async () => clone }),
  })
  await pageCreateSession({ options: {}, sessionId: 1 })
  await expect(pageCloneSession({ cloneId: 2, sessionId: 1 })).resolves.toEqual(
    { ok: true },
  )
  expect(pageContextStatus({ sessionId: 2 }).overflowed).toBe(false)
  target.dispatchEvent(new Event('contextoverflow'))
  expect(pageContextStatus({ sessionId: 2 }).overflowed).toBe(true)
  expect(pageContextStatus({ sessionId: 1 }).overflowed).toBe(false)
})

it('rejects context lookup for an unknown session', () => {
  expect(() => pageContextStatus({ sessionId: 1 })).toThrow(
    'unknown session id',
  )
})

it('does not create a native session after its registered operation was cancelled', async () => {
  const create = vi.fn()
  vi.stubGlobal('LanguageModel', { create })
  pageBeginOperation({ creating: true, operationId: 2, sessionId: 1 })
  pageCancelOperation({ operationId: 2 })
  await expect(
    pageCreateSession({ operationId: 2, options: {}, sessionId: 1 }),
  ).resolves.toMatchObject({ ok: false, error: { name: 'AbortError' } })
  expect(create).not.toHaveBeenCalled()
})

it('destroys a native session that resolves after its creation signal is cancelled', async () => {
  const pending = Promise.withResolvers<NativeChromeSession>()
  const destroy = vi.fn()
  vi.stubGlobal('LanguageModel', { create: () => pending.promise })
  pageBeginOperation({ creating: true, operationId: 2, sessionId: 1 })
  const result = pageCreateSession({
    operationId: 2,
    options: {},
    sessionId: 1,
  })
  pageCancelOperation({ operationId: 2 })
  pending.resolve({
    destroy,
    prompt: async () => 'reply',
    promptStreaming: () => new ReadableStream(),
  })
  await expect(result).resolves.toMatchObject({
    ok: false,
    error: { name: 'AbortError' },
  })
  expect(destroy).toHaveBeenCalledOnce()
  const state = globalThis as PageGlobalState
  expect(state.__odaiSessions?.size).toBe(0)
  expect(state.__odaiOperations?.size).toBe(0)
})
