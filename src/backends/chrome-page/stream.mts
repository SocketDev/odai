import { createPageOperation } from './operation.mts'
import { pagePromptStreaming } from './prompt.mts'
import { StreamQueue } from './queue.mts'

import type { Message } from '../../types.mts'
import type { PageOperation } from './operation.mts'
import type { Bridge } from './types.mts'

export interface PageStreamSpec {
  active: Set<PageOperation<unknown>>
  assertOpen(): void
  messages: Message[]
  sessionId: number
  signal?: AbortSignal | undefined
  streamId: number
}

export function createPageStream(
  bridge: Bridge,
  spec: PageStreamSpec,
): AsyncIterableIterator<string> {
  const queue = new StreamQueue()
  let stopped = false
  let operation: PageOperation<void> | undefined

  function finish(): void {
    stopped = true
    bridge.streams.delete(spec.streamId)
    queue.close({ done: true, streamId: spec.streamId })
  }

  function start(): void {
    spec.assertOpen()
    bridge.streams.set(spec.streamId, queue)
    operation = createPageOperation(
      bridge.page,
      {
        operationId: spec.streamId,
        sessionId: spec.sessionId,
      },
      () =>
        bridge.page.evaluate(pagePromptStreaming, {
          messages: spec.messages,
          operationId: spec.streamId,
          sessionId: spec.sessionId,
          streamId: spec.streamId,
        }),
      spec.signal,
    )
    spec.active.add(operation)
    const current = operation
    void current.promise
      .catch((error: unknown) => {
        queue.close({
          error: (error as Error)?.message ?? String(error),
          streamId: spec.streamId,
        })
      })
      .finally(() => {
        bridge.streams.delete(spec.streamId)
        spec.active.delete(current)
      })
  }

  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<string> {
      return this
    },
    async next(): Promise<IteratorResult<string>> {
      if (stopped) {
        return { done: true, value: undefined }
      }
      if (operation === undefined) {
        start()
      }
      const payload = await queue.next()
      if (payload.error !== undefined) {
        finish()
        if (spec.signal?.aborted === true) {
          throw spec.signal.reason
        }
        throw new Error(payload.error)
      }
      if (payload.done === true) {
        finish()
        return { done: true, value: undefined }
      }
      return { done: false, value: payload.chunk ?? '' }
    },
    async return(): Promise<IteratorResult<string>> {
      finish()
      operation?.cancel(new DOMException('Stream closed', 'AbortError'))
      return { done: true, value: undefined }
    },
    async throw(error: unknown): Promise<IteratorResult<string>> {
      finish()
      operation?.cancel(error)
      throw error
    },
  }
}
