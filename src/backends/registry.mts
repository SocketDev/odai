/**
 * @file Backend registry and selection. Selection precedence: explicit
 *   `backend` option, then the `ODAI_BACKEND` env var, then the availability
 *   probe order. Explicit choices are authoritative — an unavailable explicit
 *   backend throws with its reason instead of falling through.
 */

import { joinOr } from '@socketsecurity/lib/arrays/join'

import { createAppleFmBackend } from './apple-fm.mts'
import { createChromeBuiltinBackend } from './chrome-builtin.mts'
import { createLlamaServerBackend } from './llama-server.mts'
import { createSimulatorBackend } from './simulator.mts'
import { createWindowsPhiSilicaBackend } from './windows-phi-silica.mts'
import type { BackendName, OdaiBackend } from './types.mts'

export const ODAI_BACKEND_ENV_VAR = 'ODAI_BACKEND'

export const backendNames: readonly BackendName[] = [
  'apple-fm',
  'chrome-builtin',
  'llama-server',
  'simulator',
  'windows-phi-silica',
]

/**
 * Real engines probe first; the simulator closes the order so selection in a
 * bare Node runtime lands on a working, clearly-canned model.
 */
export const defaultProbeOrder: readonly BackendName[] = [
  'chrome-builtin',
  'llama-server',
  'apple-fm',
  'windows-phi-silica',
  'simulator',
]

export interface SelectBackendOptions {
  /**
   * Explicit backend: a registry name or a caller-built `OdaiBackend`
   * instance. Wins over the env var and the probe.
   */
  backend?: BackendName | OdaiBackend | undefined
  /**
   * Env source, `process.env` by default. Injectable for tests.
   */
  env?: Record<string, string | undefined> | undefined
  /**
   * Availability probe order when nothing explicit is set. Defaults to
   * `defaultProbeOrder`.
   */
  probe?: readonly BackendName[] | undefined
}

export function createBackend(name: BackendName): OdaiBackend {
  switch (name) {
    case 'apple-fm':
      return createAppleFmBackend()
    case 'chrome-builtin':
      return createChromeBuiltinBackend()
    case 'llama-server':
      return createLlamaServerBackend()
    case 'simulator':
      return createSimulatorBackend()
    case 'windows-phi-silica':
      return createWindowsPhiSilicaBackend()
    default:
      throw new Error(
        `Unknown odai backend "${String(name)}"; expected ${joinOr([...backendNames])}.`,
      )
  }
}

export function isBackendName(value: string): value is BackendName {
  return (backendNames as readonly string[]).includes(value)
}

export function readEnvBackend(
  env: Record<string, string | undefined>,
): BackendName | undefined {
  const value = env[ODAI_BACKEND_ENV_VAR]
  if (value === undefined || value === '') {
    return undefined
  }
  if (!isBackendName(value)) {
    throw new Error(
      `${ODAI_BACKEND_ENV_VAR} is "${value}"; expected ${joinOr([...backendNames])}. ` +
        'Unset it or pick a declared backend.',
    )
  }
  return value
}

export async function requireAvailable(
  backend: OdaiBackend,
  source: string,
): Promise<OdaiBackend> {
  const availability = await backend.availability()
  if (availability.available) {
    return backend
  }
  throw new Error(
    `Backend "${backend.name}" (selected via ${source}) is unavailable: ` +
      (availability.reason ?? 'no reason given'),
  )
}

export async function selectBackend(
  options: SelectBackendOptions = {},
): Promise<OdaiBackend> {
  const opts = { __proto__: null, ...options } as typeof options
  if (typeof opts.backend === 'object') {
    return await requireAvailable(opts.backend, 'explicit backend instance')
  }
  if (typeof opts.backend === 'string') {
    return await requireAvailable(
      createBackend(opts.backend),
      'explicit backend option',
    )
  }
  const env = opts.env ?? (typeof process === 'undefined' ? {} : process.env)
  const envName = readEnvBackend(env)
  if (envName !== undefined) {
    return await requireAvailable(
      createBackend(envName),
      `${ODAI_BACKEND_ENV_VAR} env var`,
    )
  }
  const reasons: string[] = []
  for (const name of opts.probe ?? defaultProbeOrder) {
    const backend = createBackend(name)
    const availability = await backend.availability()
    if (availability.available) {
      return backend
    }
    reasons.push(`${name}: ${availability.reason ?? 'no reason given'}`)
  }
  throw new Error(
    `No odai backend is available. Probed in order — ${reasons.join(' | ')}. ` +
      'Select the simulator backend explicitly or bring an engine up.',
  )
}
