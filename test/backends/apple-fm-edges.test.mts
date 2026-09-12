import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createAppleFmBackend,
  probeAppleFm,
} from '../../src/backends/apple-fm.mts'

const shim = vi.hoisted(() => ({
  host: vi.fn(),
  binary: vi.fn(),
  request: vi.fn(),
  dispose: vi.fn(),
}))
vi.mock(import('../../src/backends/apple-fm-shim.mts'), () => ({
  currentHost: shim.host,
  ensureShimBinary: shim.binary,
  spawnShim: () => ({ request: shim.request, dispose: shim.dispose }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  shim.host.mockReturnValue({
    arch: 'arm64',
    platform: 'darwin',
    darwinMajor: 25,
  })
  shim.binary.mockResolvedValue('/fixture/shim')
  shim.request.mockResolvedValue({ ok: true, availability: 'available' })
})
afterEach(() => vi.unstubAllGlobals())

it('reports factory availability from the actual shim probe result', async () => {
  const factory = await createAppleFmBackend({
    cacheDir: '/fixture/cache',
    env: {},
  }).languageModel()
  expect(await factory.availability()).toBe('available')
  shim.request.mockResolvedValueOnce({ ok: true, availability: 'unavailable' })
  expect(await factory.availability()).toBe('unavailable')
  expect(shim.dispose).toHaveBeenCalledTimes(2)
})

it('returns unavailable for unsupported hosts without compiling', async () => {
  shim.host.mockReturnValue({ arch: 'x64', platform: 'linux', darwinMajor: 0 })
  expect((await probeAppleFm({ env: {} })).available).toBe(false)
  expect(shim.binary).not.toHaveBeenCalled()
})

it('reports compilation failure without spawning a shim', async () => {
  shim.binary.mockRejectedValueOnce(new Error('fixture compiler absent'))
  expect(
    (await probeAppleFm({ cacheDir: '/fixture/cache', env: {} })).available,
  ).toBe(false)
  expect(shim.request).not.toHaveBeenCalled()
})

it('handles missing error details in an unsuccessful availability reply', async () => {
  shim.request.mockResolvedValueOnce({ ok: false })
  expect(
    (await probeAppleFm({ cacheDir: '/fixture/cache', env: {} })).available,
  ).toBe(false)
  expect(shim.dispose).toHaveBeenCalledTimes(1)
})

it('declines a runtime without Node support before loading a shim', async () => {
  vi.stubGlobal('process', { ...process, versions: {} })
  const result = await probeAppleFm({ env: {} })
  vi.unstubAllGlobals()
  expect(result.available).toBe(false)
  expect(shim.host).not.toHaveBeenCalled()
})
