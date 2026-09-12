import { beforeEach, expect, it, vi } from 'vitest'
import {
  createChromeBuiltinBackend,
  startBridge,
} from '../../src/backends/chrome-builtin.mts'

const boundary = vi.hoisted(() => ({
  node: vi.fn(),
  builtin: vi.fn(),
  config: vi.fn(),
  source: vi.fn(),
  version: vi.fn(),
  profile: vi.fn(),
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
  await bridge.close()
  expect(close).toHaveBeenCalledTimes(1)
  const startupError = new Error('fixture page failed')
  page.goto.mockRejectedValueOnce(startupError)
  close.mockRejectedValueOnce(new Error('fixture close failed'))
  await expect(startBridge({ launcher })).rejects.toBe(startupError)
  expect(close).toHaveBeenCalledTimes(2)
})
