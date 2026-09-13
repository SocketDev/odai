import { beforeEach, expect, it, vi } from 'vitest'

import {
  assertChromeStorage,
  CHROME_CACHED_MIN_FREE_BYTES,
  CHROME_DOWNLOAD_MIN_FREE_BYTES,
} from '../../../../../src/backends/chrome/storage.mts'

const disk = vi.hoisted(() => ({ statfs: vi.fn() }))
vi.mock(import('node:fs/promises'), async importOriginal => ({
  ...(await importOriginal()),
  statfs: disk.statfs,
}))

beforeEach(() => {
  vi.clearAllMocks()
})

it.each(['profile', 'system'] as const)(
  'allows cached %s assets at the retention floor',
  async kind => {
    disk.statfs.mockResolvedValue({
      bavail: CHROME_CACHED_MIN_FREE_BYTES / 4096,
      bsize: 4096,
    })
    await expect(
      assertChromeStorage('/fixture/profile', { kind }),
    ).resolves.toBeUndefined()
  },
)

it('requires provisioning capacity when a model download is necessary', async () => {
  disk.statfs.mockResolvedValue({
    bavail: CHROME_CACHED_MIN_FREE_BYTES,
    bsize: 1,
  })
  await expect(
    assertChromeStorage('/fixture/profile', { kind: 'download' }),
  ).rejects.toThrow(`requires at least ${CHROME_DOWNLOAD_MIN_FREE_BYTES} bytes`)
  disk.statfs.mockResolvedValue({
    bavail: CHROME_DOWNLOAD_MIN_FREE_BYTES,
    bsize: 1,
  })
  await expect(
    assertChromeStorage('/fixture/profile', { kind: 'download' }),
  ).resolves.toBeUndefined()
})

it('lets the host reclaim storage and measures the same filesystem again', async () => {
  disk.statfs
    .mockResolvedValueOnce({
      bavail: CHROME_CACHED_MIN_FREE_BYTES,
      bsize: 1,
    })
    .mockResolvedValueOnce({
      bavail: CHROME_DOWNLOAD_MIN_FREE_BYTES,
      bsize: 1,
    })
  const reclaimStorage = vi.fn().mockResolvedValue(undefined)
  await expect(
    assertChromeStorage(
      '/fixture/profile',
      { kind: 'download' },
      reclaimStorage,
    ),
  ).resolves.toBeUndefined()
  expect(reclaimStorage).toHaveBeenCalledWith({
    availableBytes: CHROME_CACHED_MIN_FREE_BYTES,
    minimumBytes: CHROME_DOWNLOAD_MIN_FREE_BYTES,
    profile: '/fixture/profile',
    source: { kind: 'download' },
  })
  expect(disk.statfs).toHaveBeenCalledTimes(2)
})

it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects unusable free-space measurements: %s',
  async bavail => {
    disk.statfs.mockResolvedValue({ bavail, bsize: 4096 })
    await expect(
      assertChromeStorage('/fixture/profile', { kind: 'profile' }),
    ).rejects.toThrow('/fixture/profile')
  },
)

it('propagates filesystem failures before launch', async () => {
  disk.statfs.mockRejectedValue(new Error('fixture filesystem unavailable'))
  await expect(
    assertChromeStorage('/fixture/profile', { kind: 'profile' }),
  ).rejects.toThrow('fixture filesystem unavailable')
})
