/**
 * @file Backend registry and selection. Selection precedence: explicit
 *   `backend` option, then the `LOCAI_BACKEND` env var, then the availability
 *   probe order. Explicit choices are authoritative — an unavailable explicit
 *   backend throws with its reason instead of falling through.
 */

import { joinOr } from '@socketsecurity/lib/arrays/join'

import { createAppleFmBackend } from './apple-fm.mts'
import { createGeminiNanoHeadlessBackend } from './gemini-nano-headless.mts'
import { createLlamaServerBackend } from './llama-server.mts'
import { createSimulatorBackend } from './simulator.mts'
import type { BackendName, LocaiBackend } from './types.mts'

export const LOCAI_BACKEND_ENV_VAR = 'LOCAI_BACKEND'

export const backendNames: readonly BackendName[] = [
  'apple-fm',
  'gemini-nano-headless',
  'llama-server',
  'simulator',
]

/**
 * Real engines probe first; the simulator closes the order so selection in a
 * bare Node runtime lands on a working, clearly-canned model.
 */
export const defaultProbeOrder: readonly BackendName[] = [
  'gemini-nano-headless',
  'llama-server',
  'apple-fm',
  'simulator',
]

export interface SelectBackendOptions {
  /**
   * Explicit backend: a registry name or a caller-built `LocaiBackend`
   * instance. Wins over the env var and the probe.
   */
  backend?: BackendName | LocaiBackend | undefined
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

export function createBackend(name: BackendName): LocaiBackend {
  switch (name) {
    case 'apple-fm':
      return createAppleFmBackend()
    case 'gemini-nano-headless':
      return createGeminiNanoHeadlessBackend()
    case 'llama-server':
      return createLlamaServerBackend()
    case 'simulator':
      return createSimulatorBackend()
    default:
      throw new Error(
        `Unknown locai backend "${String(name)}"; expected ${joinOr([...backendNames])}.`,
      )
  }
}

export function isBackendName(value: string): value is BackendName {
  return (backendNames as readonly string[]).includes(value)
}

export function readEnvBackend(
  env: Record<string, string | undefined>,
): BackendName | undefined {
  const value = env[LOCAI_BACKEND_ENV_VAR]
  if (value === undefined || value === '') {
    return undefined
  }
  if (!isBackendName(value)) {
    throw new Error(
      `${LOCAI_BACKEND_ENV_VAR} is "${value}"; expected ${joinOr([...backendNames])}. ` +
        'Unset it or pick a declared backend.',
    )
  }
  return value
}

export async function requireAvailable(
  backend: LocaiBackend,
  source: string,
): Promise<LocaiBackend> {
  const availability = await backend.availability()
  if (availability.available) {
    return backend
  }
  throw new Error(
    `Backend "${backend.name}" (selected via ${source}) is unavailable: ` +
      `${availability.reason ?? 'no reason given'}`,
  )
}

export async function selectBackend(
  options: SelectBackendOptions = {},
): Promise<LocaiBackend> {
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
      `${LOCAI_BACKEND_ENV_VAR} env var`,
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
    `No locai backend is available. Probed in order — ${reasons.join(' | ')}. ` +
      'Select the simulator backend explicitly or bring an engine up.',
  )
}
