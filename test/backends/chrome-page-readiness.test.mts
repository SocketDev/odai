import { describe, expect, it } from 'vitest'

import { waitForModelReady } from '../../src/backends/chrome-page.mts'
import type { PageLike } from '../../src/backends/chrome-page.mts'

describe('waitForModelReady', () => {
  it('returns as soon as the page reports available', async () => {
    const page: PageLike = {
      async evaluate<T>(): Promise<T> {
        return 'available' as T
      },
      async exposeFunction(): Promise<unknown> {
        return undefined
      },
      async goto(): Promise<unknown> {
        return undefined
      },
    }
    await expect(
      waitForModelReady(page, {
        allowDownload: false,
        userDataDir: '/tmp/odai-chrome-profile',
      }),
    ).resolves.toBeUndefined()
  })

  it('throws a Chrome-remedy error when the page exposes no global', async () => {
    const page: PageLike = {
      async evaluate<T>(): Promise<T> {
        return 'no-global' as T
      },
      async exposeFunction(): Promise<unknown> {
        return undefined
      },
      async goto(): Promise<unknown> {
        return undefined
      },
    }
    await expect(
      waitForModelReady(page, {
        allowDownload: false,
        userDataDir: '/tmp/odai-chrome-profile',
      }),
    ).rejects.toThrow(/no LanguageModel global/)
  })

  it('kicks a download then times out with the last state', async () => {
    const kicks: unknown[] = []
    const page: PageLike = {
      async evaluate<T>(fn: unknown): Promise<T> {
        // The kick evaluation returns a string too; record it and keep the
        // availability probe pinned at downloadable so the loop times out.
        if (kicks.length > 0 && fn !== undefined) {
          /* no-op */
        }
        kicks.push(fn)
        return 'downloadable' as T
      },
      async exposeFunction(): Promise<unknown> {
        return undefined
      },
      async goto(): Promise<unknown> {
        return undefined
      },
    }
    await expect(
      waitForModelReady(page, {
        allowDownload: true,
        readyTimeoutMs: 30,
        userDataDir: '/tmp/odai-chrome-profile',
      }),
    ).rejects.toThrow(/did not become available.*downloadable/s)
    // The download kick fired at least once alongside the availability polls.
    expect(kicks.length).toBeGreaterThan(1)
  })
})
