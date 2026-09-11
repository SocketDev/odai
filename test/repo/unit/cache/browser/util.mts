import fs from 'node:fs/promises'
import os from 'node:os'
import { afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'

export function createBrowserFixture(mocks: {
  launch: Mock
  nativeClose: Mock
  nativeRead: Mock
}) {
  mocks.nativeRead.mockResolvedValue({
    log: { status: 'captured', events: [], truncated: false },
    memory: { status: 'unavailable' },
  })
  mocks.nativeClose.mockResolvedValue(undefined)
  vi.spyOn(os, 'arch').mockReturnValue('x64')
  vi.spyOn(os, 'availableParallelism').mockReturnValue(8)
  vi.spyOn(os, 'platform').mockReturnValue('linux')
  vi.spyOn(os, 'totalmem').mockReturnValue(32 * 1024 ** 3)
  vi.spyOn(fs, 'statfs').mockResolvedValue({
    bavail: 30 * 1024 ** 3,
    bfree: 30 * 1024 ** 3,
    blocks: 60 * 1024 ** 3,
    bsize: 1,
    frsize: 1,
    ffree: 100,
    files: 100,
    type: 1,
  })
  const evaluate = vi
    .fn()
    .mockResolvedValueOnce('available')
    .mockResolvedValueOnce('Gemma 4')
  const page = { evaluate, goto: vi.fn().mockResolvedValue(undefined) }
  const send = vi
    .fn()
    .mockResolvedValueOnce({ product: 'Chrome/154.0.8037.17' })
    .mockResolvedValueOnce({ arguments: ['--enable-automation'] })
    .mockResolvedValue({ histograms: [] })
  const brokerEvaluate = vi.fn().mockResolvedValue({
    models: [{ backendType: 'CPU' }],
    useCases: [{ name: 'language_model', unavailableReason: undefined }],
  })
  const brokerClose = vi.fn().mockResolvedValue(undefined)
  const close = vi.fn().mockResolvedValue(undefined)
  mocks.launch.mockResolvedValue({
    close,
    context: {
      close,
      newCDPSession: vi.fn().mockResolvedValue({
        send,
        detach: vi.fn().mockResolvedValue(undefined),
      }),
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        locator: vi.fn().mockReturnValue({
          evaluate: brokerEvaluate,
          waitFor: vi.fn().mockResolvedValue(undefined),
        }),
        url: vi.fn().mockReturnValue('chrome://on-device-internals/'),
        close: brokerClose,
      }),
    },
    page,
  })
  vi.spyOn(fs, 'readFile').mockResolvedValue(
    JSON.stringify({
      browser: { enabled_labs_experiments: ['gemma4-for-built-in-ai@1'] },
    }),
  )
  return { brokerClose, brokerEvaluate, close, evaluate, send }
}

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  nativeClose: vi.fn(),
  nativeCreate: vi.fn(),
  nativeRead: vi.fn(),
}))
vi.mock(import('../../../../../scripts/repo/cache/native.mts'), () => ({
  createGemmaNativeDiagnostics: mocks.nativeCreate,
}))
vi.mock(import('node:timers/promises'), async importOriginal => ({
  ...(await importOriginal()),
  setTimeout: <T = void,>(ms?: number | undefined, value?: T | undefined) =>
    new Promise<T>(resolve => setTimeout(() => resolve(value!), ms)),
}))
vi.mock(
  import('../../../../../scripts/repo/cache/browser/acquire.mts'),
  () => ({
    acquireCacheBrowserSession: mocks.launch,
  }),
)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

export function browserFixture() {
  mocks.nativeCreate.mockResolvedValue({
    logFile: '/example/private/chrome.log',
    read: mocks.nativeRead,
    close: mocks.nativeClose,
  })
  return createBrowserFixture(mocks)
}

export const probeOptions = {
  bridge: '/example/profile/odai-cache.html',
  browser: '/example/chrome-beta',
  offline: false,
  profile: '/example/profile',
  timeoutMs: 60_000,
}

export function getBrowserMocks() {
  return mocks
}
