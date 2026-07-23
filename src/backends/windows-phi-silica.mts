/**
 * @file Phi Silica (Copilot+) backend, the declared Windows provider. Phi
 *   Silica is the on-device model behind the Windows App SDK Language Model
 *   APIs and it runs only on the NPU of Copilot+ hardware — hosted CI VMs
 *   never qualify, exactly like Apple Foundation Models in macOS VMs. The
 *   provider is declared in the registry so selection and docs name it
 *   honestly, and availability always carries the precise hardware reason
 *   until a Copilot+ machine exists to bridge it for real.
 */

import type { LanguageModelLike } from '../types.mts'
import type { BackendAvailability, LocaiBackend } from './types.mts'

export interface WindowsPhiSilicaBackendOptions {
  /**
   * Host platform, `process.platform` by default. Injectable for tests.
   */
  platform?: string | undefined
}

export function createWindowsPhiSilicaBackend(
  options?: WindowsPhiSilicaBackendOptions | undefined,
): LocaiBackend {
  const opts = { __proto__: null, ...options } as WindowsPhiSilicaBackendOptions
  return {
    async availability(): Promise<BackendAvailability> {
      return probeWindowsPhiSilica(opts)
    },
    async languageModel(): Promise<LanguageModelLike> {
      const probe = await probeWindowsPhiSilica(opts)
      throw new Error(
        `Phi Silica (Copilot+) has no session bridge yet: ${probe.reason ?? 'declared provider only'}`,
      )
    },
    name: 'windows-phi-silica',
  }
}

export function probeWindowsPhiSilica(
  options?: WindowsPhiSilicaBackendOptions | undefined,
): BackendAvailability {
  const opts = { __proto__: null, ...options } as WindowsPhiSilicaBackendOptions
  const platform =
    opts.platform ??
    (typeof process === 'undefined' ? 'browser' : process.platform)
  if (platform !== 'win32') {
    return {
      available: false,
      reason:
        'Phi Silica (Copilot+) needs Windows 11 on Copilot+ hardware; ' +
        `this host is ${platform}.`,
    }
  }
  return {
    available: false,
    reason:
      'Phi Silica (Copilot+) needs a Copilot+ NPU — hosted CI VMs are ' +
      'ineligible, and the session bridge awaits real Copilot+ hardware.',
  }
}
