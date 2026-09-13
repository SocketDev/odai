import { expect, it, vi } from 'vitest'
import {
  awaitStreamValue,
  consumeStream,
  STREAM_ABORTED,
} from '../../../src/stream.mts'

it('settles an already cancelled value without exposing a late rejection', async () => {
  const controller = new AbortController()
  controller.abort(new Error('Cancelled before reading'))
  const pending = Promise.reject(new Error('Late provider failure'))
  await expect(awaitStreamValue(pending, controller.signal)).resolves.toBe(
    STREAM_ABORTED,
  )
})

it('cancels an already aborted reader without consuming or delivering a chunk', async () => {
  const controller = new AbortController()
  const reason = new Error('Cancelled before reading')
  controller.abort(reason)
  const cancel = vi.fn()
  const onChunk = vi.fn()
  const stream = new ReadableStream<string>({ cancel })
  await expect(consumeStream(stream, onChunk, controller.signal)).resolves.toBe(
    true,
  )
  expect(onChunk).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledExactlyOnceWith(reason)
  expect(stream.locked).toBe(false)
})
