import { afterEach, describe, expect, it, vi } from 'vitest'

import { waitForModelReady } from '../../src/backends/chrome-page.mts'
import type { PageLike } from '../../src/backends/chrome-page.mts'

afterEach(() => {
  vi.useRealTimers()
})

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
    vi.useFakeTimers()
    const kicks: unknown[] = []
    const page: PageLike = {
      async evaluate<T>(fn: unknown): Promise<T> {
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
    const pending = waitForModelReady(page, {
      allowDownload: true,
      readyTimeoutMs: 30,
      userDataDir: '/tmp/odai-chrome-profile',
    })
    const rejection = expect(pending).rejects.toThrow(Error)
    await vi.advanceTimersByTimeAsync(30)
    expect(vi.getTimerCount()).toBe(0)
    await rejection
    // The download kick fired at least once alongside the availability polls.
    expect(kicks.length).toBeGreaterThan(1)
  })
})
