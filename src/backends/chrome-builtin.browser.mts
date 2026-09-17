import {
  getLanguageModel,
  probeBuiltinAvailability,
} from '../builtin-availability.mts'
import type {
  ChromeBuiltinBackend,
  ChromeBuiltinOptions,
} from './chrome-builtin.mts'

export function createChromeBuiltinBackend(
  options?: ChromeBuiltinOptions | undefined,
): ChromeBuiltinBackend {
  void options
  return {
    async availability() {
      const result = await probeBuiltinAvailability()
      return result.available
        ? { available: true }
        : {
            available: false,
            reason: 'The browser LanguageModel is unavailable on this device.',
          }
    },
    async close() {},
    async languageModel() {
      const factory = getLanguageModel()
      if (factory === undefined) {
        throw new Error(
          'The browser LanguageModel is unavailable on this device.',
        )
      }
      return factory
    },
    name: 'chrome-builtin',
  }
}
