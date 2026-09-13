import { loadNodeDeps } from '../chrome-profile.mts'

import type { ModelSource } from '../chrome-profile.mts'

export const CHROME_CACHED_MIN_FREE_BYTES = 10 * 1024 ** 3
export const CHROME_DOWNLOAD_MIN_FREE_BYTES = 22 * 1024 ** 3

export interface ChromeStoragePressure {
  availableBytes: number
  minimumBytes: number
  profile: string
  source: ModelSource
}

export type ReclaimChromeStorage = (
  pressure: ChromeStoragePressure,
) => Promise<void>

export async function assertChromeStorage(
  profile: string,
  source: ModelSource,
  reclaimStorage?: ReclaimChromeStorage | undefined,
): Promise<void> {
  const { fsp } = await loadNodeDeps()
  const minimumBytes =
    source.kind === 'download'
      ? CHROME_DOWNLOAD_MIN_FREE_BYTES
      : CHROME_CACHED_MIN_FREE_BYTES
  let disk = await fsp.statfs(profile)
  let freeBytes = disk.bavail * disk.bsize
  if (freeBytes < minimumBytes && reclaimStorage !== undefined) {
    await reclaimStorage({
      availableBytes: freeBytes,
      minimumBytes,
      profile,
      source,
    })
    disk = await fsp.statfs(profile)
    freeBytes = disk.bavail * disk.bsize
  }
  if (!Number.isFinite(freeBytes) || freeBytes < minimumBytes) {
    throw new Error(
      `Chrome launch has insufficient disk space at ${profile}. Found ${freeBytes} bytes free; requires at least ${minimumBytes} bytes. Free disk space before launching Chrome to prevent cached model removal.`,
    )
  }
}
