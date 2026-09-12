import type { AppleFmBackendOptions } from './apple-fm.mts'
import type { OdaiBackend } from './types.mts'

export const ODAI_APPLE_FM_SHIM_ENV_VAR = 'ODAI_APPLE_FM_SHIM'
export const APPLE_FM_BROWSER_REASON =
  'Apple Foundation Models requires the Node entry to start its native shim.'

export function createAppleFmBackend(
  options?: AppleFmBackendOptions | undefined,
): OdaiBackend {
  void options
  return {
    async availability() {
      return {
        __proto__: null,
        available: false,
        reason: APPLE_FM_BROWSER_REASON,
      }
    },
    async languageModel() {
      throw new Error(APPLE_FM_BROWSER_REASON)
    },
    name: 'apple-fm',
  }
}
