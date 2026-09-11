import assert from 'node:assert/strict'
import os from 'node:os'
import { afterEach, expect, test, vi } from 'vitest'
import { acquireCacheBrowserSession } from '../../../../../scripts/repo/cache/browser/acquire.mts'

const mocks = vi.hoisted(() => ({
  graft: vi.fn(),
  launch: vi.fn(),
  mkdir: vi.fn(),
  profile: vi.fn(),
}))
vi.mock(import('node:fs/promises'), async original => {
  const actual = await original()
  return { ...actual, default: { ...actual.default, mkdir: mocks.mkdir } }
})
vi.mock(
  import('../../../../../scripts/fleet/browser/control/one-password.mts'),
  () => ({ ensureOnePasswordGraft: mocks.graft }),
)
vi.mock(import('playwright-core'), async original => {
  const actual = await original()
  return {
    ...actual,
    chromium: { ...actual.chromium, launchPersistentContext: mocks.launch },
  }
})
vi.mock(
  import('../../../../../scripts/repo/cache/util.mts'),
  async original => ({
    ...(await original()),
    assertCacheProfile: mocks.profile,
  }),
)

const config = {
  executablePath: '/example/chrome-beta',
  network: 'provision' as const,
  profileDir: '/example/model-cache',
  timeoutMs: 60_000,
}
afterEach(() => {
  vi.restoreAllMocks()
  mocks.launch.mockReset()
  mocks.profile.mockReset()
  mocks.graft.mockReset()
  mocks.mkdir.mockReset()
})

test('launches only a dedicated cache profile with a pinned executable and sandbox', async () => {
  const page = {}
  const close = vi.fn()
  mocks.launch.mockResolvedValue({ pages: () => [page], close })
  const session = await acquireCacheBrowserSession(config)
  expect(mocks.profile).toHaveBeenCalledWith(config.profileDir)
  expect(mocks.launch).toHaveBeenCalledWith(config.profileDir, {
    args: [
      '--enable-automation',
      '--disable-features=DialMediaRouteProvider,GlobalMediaControls,MediaRouter,Translate',
    ],
    chromiumSandbox: true,
    executablePath: config.executablePath,
    headless: true,
    ignoreDefaultArgs: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-field-trial-config',
    ],
    timeout: 40_000,
  })
  expect(session.page).toBe(page)
  await session.close()
  expect(close).toHaveBeenCalledOnce()
})

test('refuses unmarked profiles before launch and closes failed page setup', async () => {
  mocks.profile.mockRejectedValueOnce(new Error('invalid profile'))
  await expect(acquireCacheBrowserSession(config)).rejects.toThrow()
  expect(mocks.launch).not.toHaveBeenCalled()
  const close = vi.fn()
  mocks.launch.mockResolvedValue({
    pages: () => [],
    newPage: vi.fn().mockRejectedValue(new Error('page failed')),
    close,
  })
  await expect(acquireCacheBrowserSession(config)).rejects.toThrow()
  expect(close).toHaveBeenCalledOnce()
})

test.each([false, true])(
  'acquires an isolated model context with offline=%s',
  async offline => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({})
    const context = { close: vi.fn(), pages: () => [{}] }
    mocks.launch.mockResolvedValue(context)
    assert.equal(
      (
        await acquireCacheBrowserSession({
          profileDir: '/example/model-profile',
          executablePath: '/example/chrome-beta',
          network: offline ? 'offline' : 'provision',
          timeoutMs: 60_000,
        })
      ).context,
      context,
    )
    assert.deepEqual(mocks.launch.mock.calls.at(-1), [
      '/example/model-profile',
      {
        args: [
          '--enable-automation',
          '--disable-features=DialMediaRouteProvider,GlobalMediaControls,MediaRouter,Translate',
        ],
        chromiumSandbox: true,
        executablePath: '/example/chrome-beta',
        headless: true,
        ignoreDefaultArgs: offline
          ? []
          : [
              '--disable-background-networking',
              '--disable-component-update',
              '--disable-field-trial-config',
            ],
        timeout: 40_000,
      },
    ])
    assert.equal(mocks.graft.mock.calls.length, 0)
    assert.equal(mocks.mkdir.mock.calls.length, 0)
  },
)
