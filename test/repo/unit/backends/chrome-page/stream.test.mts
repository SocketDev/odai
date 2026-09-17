import { expect, it, vi } from 'vitest'

import { pageBeginOperation } from '../../../../../src/backends/chrome-page/operations.mts'
import { pagePromptStreaming } from '../../../../../src/backends/chrome-page/prompt.mts'
import { createPageStream } from '../../../../../src/backends/chrome-page/stream.mts'
import type { PageOperation } from '../../../../../src/backends/chrome-page/operation.mts'
import type {
  Bridge,
  PageLike,
} from '../../../../../src/backends/chrome-page/types.mts'

export function streamBridgeFixture(): Bridge {
  const page: PageLike = {
    async evaluate<T>(fn: unknown): Promise<T> {
      if (fn === pageBeginOperation) {
        return { ok: true } as T
      }
      if (fn === pagePromptStreaming) {
        return await new Promise<T>(() => {})
      }
      return undefined as T
    },
    exposeFunction: async () => undefined,
    goto: async () => undefined,
  }
  return { close: async () => undefined, page, streams: new Map() }
}

it('does not dispatch another read after the stream iterator has returned', async () => {
  const bridge = streamBridgeFixture()
  const assertOpen = vi.fn()
  const stream = createPageStream(bridge, {
    active: new Set(),
    assertOpen,
    messages: [],
    sessionId: 1,
    streamId: 2,
  })
  await stream.return!()
  await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
  expect(assertOpen).not.toHaveBeenCalled()
})

it('preserves the caller abort reason and clears a pending stream queue', async () => {
  const bridge = streamBridgeFixture()
  const controller = new AbortController()
  const active = new Set<PageOperation<unknown>>()
  const stream = createPageStream(bridge, {
    active,
    assertOpen: () => {},
    messages: [],
    sessionId: 1,
    signal: controller.signal,
    streamId: 2,
  })
  const pending = stream.next()
  const reason = new Error('caller cancelled stream')
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  await vi.waitFor(() => {
    expect(active.size).toBe(0)
  })
  expect(bridge.streams.size).toBe(0)
})

it('throws into a pending stream without leaving its reader or operation registered', async () => {
  const bridge = streamBridgeFixture()
  const active = new Set<PageOperation<unknown>>()
  const stream = createPageStream(bridge, {
    active,
    assertOpen: () => {},
    messages: [],
    sessionId: 1,
    streamId: 2,
  })
  const pending = stream.next()
  const reason = new Error('consumer stopped with an error')
  await expect(stream.throw!(reason)).rejects.toBe(reason)
  await expect(pending).resolves.toEqual({ done: true, value: undefined })
  await vi.waitFor(() => {
    expect(active.size).toBe(0)
  })
  expect(bridge.streams.size).toBe(0)
})
