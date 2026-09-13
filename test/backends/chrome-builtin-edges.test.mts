import { beforeEach, expect, it, vi } from 'vitest'
import {
  createChromeBuiltinBackend,
  startBridge,
} from '../../src/backends/chrome-builtin.mts'
import { StreamQueue } from '../../src/backends/chrome-page/queue.mts'

const boundary = vi.hoisted(() => ({
  node: vi.fn(),
  builtin: vi.fn(),
  config: vi.fn(),
  source: vi.fn(),
  version: vi.fn(),
  profile: vi.fn(),
  statfs: vi.fn(),
}))
vi.mock(import('node:fs/promises'), async importOriginal => ({
  ...(await importOriginal()),
  statfs: boundary.statfs,
}))
vi.mock(import('../../src/builtin-availability.mts'), () => ({
  getLanguageModel: boundary.builtin,
  probeBuiltinAvailability: async () => ({
    available: false,
    cloneCapable: false,
    namespace: 'none',
  }),
}))
vi.mock(
  import('../../src/backends/chrome-profile.mts'),
  async importOriginal => ({
    ...(await importOriginal()),
    isNodeRuntime: boundary.node,
    resolveBridgeConfig: boundary.config,
    findModelSource: boundary.source,
    readChromeMajorVersion: boundary.version,
    ensureBridgeProfile: boundary.profile,
  }),
)
vi.mock(import('playwright-core'), () => {
  throw new Error('Optional dependency absent in fixture')
})

beforeEach(() => {
  vi.clearAllMocks()
  boundary.builtin.mockReturnValue(undefined)
  boundary.node.mockReturnValue(true)
  boundary.config.mockResolvedValue({
    allowDownload: false,
    chromePath: '/fixture/chrome',
    chromePathCandidates: [],
    model: 'geminiNano',
    systemChromeUserDataDir: '/fixture/system',
    userDataDir: '/fixture/profile',
  })
  boundary.source.mockResolvedValue({ kind: 'profile' })
  boundary.version.mockResolvedValue(150)
  boundary.profile.mockResolvedValue('/fixture/bridge.html')
  boundary.statfs.mockResolvedValue({ bavail: 24 * 1024 ** 3, bsize: 1 })
})

it('rejects low disk space before Chrome can remove a cached model', async () => {
  const launcher = { launchPersistentContext: vi.fn() }
  boundary.statfs.mockResolvedValue({ bavail: 6 * 1024 ** 3, bsize: 1 })
  await expect(startBridge({ launcher })).rejects.toThrow(
    'Found 6442450944 bytes free; requires at least 10737418240 bytes',
  )
  expect(boundary.statfs).toHaveBeenCalledWith('/fixture/profile')
  expect(launcher.launchPersistentContext).not.toHaveBeenCalled()
})

it('rejects a non-Node runtime without bridge discovery', async () => {
  boundary.node.mockReturnValue(false)
  const backend = createChromeBuiltinBackend()
  expect((await backend.availability()).available).toBe(false)
  await expect(backend.languageModel()).rejects.toThrow()
  expect(boundary.config).not.toHaveBeenCalled()
})

it('reports unsupported model versions and missing model assets', async () => {
  boundary.version.mockResolvedValueOnce(1)
  expect((await createChromeBuiltinBackend().availability()).available).toBe(
    false,
  )
  boundary.version.mockResolvedValueOnce(1)
  await expect(startBridge({})).rejects.toThrow()
  boundary.source.mockResolvedValue({
    kind: 'profile',
    reason: 'fixture assets missing',
  })
  expect((await createChromeBuiltinBackend().availability()).available).toBe(
    false,
  )
  await expect(startBridge({})).rejects.toThrow()
  expect(boundary.profile).not.toHaveBeenCalled()
})

it('reports missing optional launcher before profile preparation', async () => {
  expect((await createChromeBuiltinBackend().availability()).available).toBe(
    false,
  )
  await expect(startBridge({})).rejects.toThrow()
  expect(boundary.profile).not.toHaveBeenCalled()
})

it('reports unsupported Gemma Chrome versions and closes a rejected startup safely', async () => {
  const config = await boundary.config()
  boundary.config.mockResolvedValue({ ...config, model: 'gemma4' })
  boundary.version.mockResolvedValue(152)
  const backend = createChromeBuiltinBackend()
  expect(await backend.availability()).toMatchObject({
    available: false,
    reason: expect.any(String),
  })
  await expect(backend.languageModel()).rejects.toThrow()
  await expect(backend.close()).resolves.toBeUndefined()
  expect(boundary.profile).not.toHaveBeenCalled()
})

it('closes an owned bridge and preserves startup errors when cleanup fails', async () => {
  const close = vi.fn().mockResolvedValue(undefined)
  const page = {
    evaluate: vi.fn().mockResolvedValue('available'),
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
  }
  const launcher = {
    launchPersistentContext: vi
      .fn()
      .mockResolvedValue({ close, newPage: async () => page }),
  }
  const bridge = await startBridge({ launcher })
  const queue = new StreamQueue()
  const pending = queue.next()
  bridge.streams.set(1, queue)
  await bridge.close()
  await expect(pending).resolves.toEqual({
    error: 'Chrome bridge closed',
    streamId: 1,
  })
  expect(bridge.streams.size).toBe(0)
  expect(close).toHaveBeenCalledTimes(1)
  const startupError = new Error('fixture page failed')
  page.goto.mockRejectedValueOnce(startupError)
  close.mockRejectedValueOnce(new Error('fixture close failed'))
  await expect(startBridge({ launcher })).rejects.toBe(startupError)
  expect(close).toHaveBeenCalledTimes(2)
})
