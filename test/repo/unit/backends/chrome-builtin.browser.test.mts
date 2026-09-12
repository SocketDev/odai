import { afterEach, expect, it, vi } from 'vitest'

import {
  getLanguageModel,
  probeBuiltinAvailability,
} from '../../../../src/builtin-availability.mts'
import { createChromeBuiltinBackend } from '../../../../src/backends/chrome-builtin.browser.mts'

import { stubSession } from '../../../_shared/session-stub.mts'

vi.mock('../../../../src/builtin-availability.mts', () => ({
  getLanguageModel: vi.fn(),
  probeBuiltinAvailability: vi.fn(),
}))

afterEach(() => {
  vi.resetAllMocks()
})

it('reports unavailable browser factories without launching a bridge', async () => {
  vi.mocked(probeBuiltinAvailability).mockResolvedValue({
    available: false,
    cloneCapable: false,
    namespace: 'none',
  })
  const backend = createChromeBuiltinBackend()
  expect((await backend.availability()).available).toBe(false)
  await expect(backend.languageModel()).rejects.toThrow()
  await expect(backend.close()).resolves.toBeUndefined()
})

it('wraps native sessions and their clones with constraint fallback', async () => {
  const destroy = vi.fn()
  const prompt = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('unsupported constraint'))
    .mockResolvedValue('ready')
  const clone = stubSession({ destroy, prompt })
  vi.mocked(getLanguageModel).mockReturnValue({
    availability: async () => 'available',
    create: async () => stubSession({ clone: async () => clone }),
  })
  vi.mocked(probeBuiltinAvailability).mockResolvedValue({
    available: true,
    cloneCapable: true,
    namespace: 'modern',
  })
  const backend = createChromeBuiltinBackend()
  expect((await backend.availability()).available).toBe(true)
  const factory = await backend.languageModel()
  expect(await factory.availability()).toBe('available')
  const session = await factory.create()
  const copy = await session.clone!()
  const messages = [{ role: 'user' as const, content: 'hello' }]
  expect(
    await copy.prompt(messages, { responseConstraint: { type: 'string' } }),
  ).toBe('ready')
  expect(prompt).toHaveBeenCalledTimes(2)
  expect(prompt).toHaveBeenLastCalledWith(messages)
  copy.destroy!()
  expect(destroy).toHaveBeenCalledTimes(1)
})
