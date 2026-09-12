import { cacheBrowserLaunchOptions } from './policy.mts'
import type { CacheSessionConfig } from './policy.mts'
import { assertCacheProfile } from '../util.mts'

export async function acquireCacheBrowserSession(config: CacheSessionConfig) {
  const options = { __proto__: null, ...config } as CacheSessionConfig
  const shape = cacheBrowserLaunchOptions(options)
  await assertCacheProfile(options.profileDir)
  const { chromium } = await import('playwright-core')
  const context = await chromium.launchPersistentContext(options.profileDir, {
    ...shape,
    chromiumSandbox: true,
  })
  try {
    const page = context.pages()[0] ?? (await context.newPage())
    return {
      __proto__: null,
      close: () => context.close(),
      context,
      page,
      profileDir: options.profileDir,
    }
  } catch (error) {
    await context.close()
    throw error
  }
}
