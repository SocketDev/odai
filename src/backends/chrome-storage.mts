import { loadNodeDeps } from './chrome-profile.mts'

import type { ModelSource } from './chrome-profile.mts'

export const CHROME_CACHED_MIN_FREE_BYTES = 10 * 1024 ** 3
export const CHROME_DOWNLOAD_MIN_FREE_BYTES = 22 * 1024 ** 3

export async function assertChromeStorage(
  profile: string,
  source: ModelSource,
): Promise<void> {
  const { fsp } = await loadNodeDeps()
  const disk = await fsp.statfs(profile)
  const freeBytes = disk.bavail * disk.bsize
  const minimumBytes =
    source.kind === 'download'
      ? CHROME_DOWNLOAD_MIN_FREE_BYTES
      : CHROME_CACHED_MIN_FREE_BYTES
  if (!Number.isFinite(freeBytes) || freeBytes < minimumBytes) {
    throw new Error(
      `Chrome launch has insufficient disk space at ${profile}. Found ${freeBytes} bytes free; requires at least ${minimumBytes} bytes. Free disk space before launching Chrome to prevent cached model removal.`,
    )
  }
}
