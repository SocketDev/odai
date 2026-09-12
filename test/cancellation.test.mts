import { expect, it, vi } from 'vitest'
import { awaitCancellable } from '../src/cancellation.mts'

it('destroys a session that arrives after cancellation', async () => {
  const controller = new AbortController()
  const dispose = vi.fn()
  let finish!: (value: object) => void
  const resource = {}
  const acquisition = new Promise<object>(resolve => {
    finish = resolve
  })
  const pending = awaitCancellable(acquisition, controller.signal, dispose)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  finish(resource)
  await acquisition
  expect(dispose).toHaveBeenCalledExactlyOnceWith(resource)
})

it('preserves failure and success when no cancellation occurs', async () => {
  expect(await awaitCancellable(Promise.resolve(7), undefined)).toBe(7)
  const error = new Error('fixture failure')
  await expect(
    awaitCancellable(Promise.reject(error), new AbortController().signal),
  ).rejects.toBe(error)
})
