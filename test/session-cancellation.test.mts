import { expect, it, vi } from 'vitest'
import { createWithFallback } from '../src/session.mts'
import { createMockSession } from '../src/mock.mts'

it('destroys a late created session after cancellation without retrying', async () => {
  const controller = new AbortController()
  const session = createMockSession({ response: '{}' })
  const destroy = vi.fn()
  session.destroy = destroy
  let finish!: (value: typeof session) => void
  const acquisition = new Promise<typeof session>(resolve => {
    finish = resolve
  })
  const create = vi.fn().mockReturnValue(acquisition)
  const pending = createWithFallback(
    { availability: async () => 'available', create },
    { abortSignal: controller.signal },
  )
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  finish(session)
  await acquisition
  expect(destroy).toHaveBeenCalledTimes(1)
  expect(create).toHaveBeenCalledTimes(1)
})

it('does not start a fallback after cancellation during an unsupported-options failure', async () => {
  const controller = new AbortController()
  const create = vi.fn().mockImplementation(async () => {
    controller.abort()
    throw new TypeError('unsupported options')
  })
  await expect(
    createWithFallback(
      { availability: async () => 'available', create },
      { abortSignal: controller.signal },
    ),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(create).toHaveBeenCalledTimes(1)
})
