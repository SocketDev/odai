import { getLanguageModel, probeAvailability } from '../availability.mts'
import { wrapFactoryWithConstraintFallback } from './chrome-constraint.mts'
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
      const result = await probeAvailability()
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
      return wrapFactoryWithConstraintFallback(factory)
    },
    name: 'chrome-builtin',
  }
}
