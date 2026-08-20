/**
 * @file Provision the two opt-in test lanes so nothing has to stay skipped.
 *   Lane `chrome` puts real Google Chrome on the machine (Chromium cannot run
 *   the built-in model), lane `model` makes Chrome fetch the on-device model
 *   component once, and lane `conformance` checks out the pinned llama.cpp
 *   submodule and warms the pinned python packages. `--check` reports readiness
 *   and downloads nothing, which is what a fresh clone wants to see before it
 *   spends 4 GB.
 *   Run: `pnpm run setup:e2e` / `pnpm run setup:e2e --check`.
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib/logger/default'
import { spawn } from '@socketsecurity/lib/process/spawn/child'

import { createChromeBuiltinBackend } from '../../src/backends/chrome-builtin.mts'
import {
  chromePathCandidates,
  findModelSource,
  ODAI_CHROME_ALLOW_DOWNLOAD_ENV_VAR,
  resolveBridgeConfig,
} from '../../src/backends/chrome-profile.mts'
import { createOdaiModel } from '../../src/model.mts'
import { PYTHON_PINS } from './llama-cpp-server/executor.mts'
import { isMainModule } from '../../scripts/fleet/_shared/is-main-module.mts'
import { runMain } from '../../scripts/fleet/_shared/run-main.mts'
import { REPO_ROOT } from '../../scripts/fleet/paths.mts'
import type { ScriptMeta } from '../../scripts/fleet/_shared/run-main.mts'

const logger = getDefaultLogger()

/**
 * The prompt that makes Chrome activate the model. One short turn is enough:
 * activation is what triggers the component download, not the token count.
 */
const WARM_PROMPT = 'Reply with exactly: odai setup ready'

const PLAYWRIGHT_CLI = 'node_modules/playwright-core/cli.js'

const PYTHON_VERSION = '3.12'

const SUBMODULE_MARKER = path.join(
  'upstream',
  'llama.cpp',
  'tools',
  'server',
  'tests',
  'utils.py',
)

export type LaneName = 'chrome' | 'conformance' | 'model'

export const LANES: readonly LaneName[] = ['chrome', 'model', 'conformance']

export interface LaneOptions {
  /**
   * Report only. Nothing is downloaded, installed, or checked out.
   */
  check: boolean
}

export interface LaneStatus {
  detail: string
  lane: LaneName
  ready: boolean
}

export interface SetupOptions extends LaneOptions {
  lanes: readonly LaneName[]
}

/**
 * Parse argv into lanes plus the check flag. No lane flag means every lane.
 */
export function parseSetupArgs(argv: readonly string[]): SetupOptions {
  const lanes: LaneName[] = []
  let check = false
  for (let i = 0, { length } = argv; i < length; i += 1) {
    const token = argv[i]!
    if (token === '--check') {
      check = true
      continue
    }
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument ${token}.`)
    }
    const name = token.slice(2) as LaneName
    if (!LANES.includes(name)) {
      throw new Error(
        `unknown option ${token}. Lanes: ` +
          `${LANES.map(lane => `--${lane}`).join(', ')}, plus --check.`,
      )
    }
    lanes.push(name)
  }
  return { check, lanes: lanes.length > 0 ? lanes : LANES }
}

/**
 * Is real Chrome on this machine? Reuses odai's own candidate list, so setup
 * and the backend can never disagree about what counts.
 */
export function findChrome(): string | undefined {
  const candidates = chromePathCandidates(
    process.platform,
    process.env,
    os.homedir(),
  )
  for (let i = 0, { length } = candidates; i < length; i += 1) {
    if (existsSync(candidates[i]!)) {
      return candidates[i]!
    }
  }
  return undefined
}

/**
 * Install real Google Chrome through playwright-core's installer, which pulls
 * the `chrome` channel (Google's own build) rather than Chromium.
 */
export async function installChrome(): Promise<void> {
  logger.info('installing Google Chrome through playwright-core…')
  await spawn(
    'node',
    [path.join(REPO_ROOT, PLAYWRIGHT_CLI), 'install', 'chrome'],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  )
}

export async function chromeLane(options: LaneOptions): Promise<LaneStatus> {
  const opts = { __proto__: null, ...options } as typeof options
  const found = findChrome()
  if (found !== undefined) {
    return { detail: found, lane: 'chrome', ready: true }
  }
  if (opts.check) {
    return {
      detail: 'not installed; `pnpm run setup:e2e --chrome` installs it',
      lane: 'chrome',
      ready: false,
    }
  }
  await installChrome()
  const installed = findChrome()
  return {
    detail:
      installed ??
      'playwright-core reported success, but no Chrome is on the candidate list',
    lane: 'chrome',
    ready: installed !== undefined,
  }
}

export async function modelLane(options: LaneOptions): Promise<LaneStatus> {
  const opts = { __proto__: null, ...options } as typeof options
  const config = await resolveBridgeConfig({ env: process.env })
  const source = await findModelSource(config)
  if (source.kind !== 'download') {
    return {
      detail:
        'model component present in the ' +
        `${source.kind === 'system' ? 'system Chrome' : 'bridge'} profile`,
      lane: 'model',
      ready: true,
    }
  }
  if (opts.check) {
    return {
      detail:
        'no model component yet; `pnpm run setup:e2e --model` lets Chrome ' +
        'download it (~4 GB, one time)',
      lane: 'model',
      ready: false,
    }
  }
  logger.info(
    'asking Chrome to download the on-device model component; this takes a ' +
      'while and needs ~22 GB free disk',
  )
  process.env[ODAI_CHROME_ALLOW_DOWNLOAD_ENV_VAR] = '1'
  const backend = createChromeBuiltinBackend()
  try {
    const availability = await backend.availability()
    if (!availability.available) {
      return {
        detail: availability.reason ?? 'the backend reported unavailable',
        lane: 'model',
        ready: false,
      }
    }
    const model = await createOdaiModel({ backend })
    const result = await model.promptStreaming(WARM_PROMPT)
    return {
      detail: `model answered (${result.raw.trim().slice(0, 40)})`,
      lane: 'model',
      ready: true,
    }
  } finally {
    await backend.close()
  }
}

export async function conformanceLane(
  options: LaneOptions,
): Promise<LaneStatus> {
  const opts = { __proto__: null, ...options } as typeof options
  const marker = path.join(REPO_ROOT, SUBMODULE_MARKER)
  const haveUv = await hasUv()
  if (existsSync(marker) && haveUv) {
    if (opts.check) {
      return {
        detail: 'submodule checked out, uv present',
        lane: 'conformance',
        ready: true,
      }
    }
    await warmPythonEnv()
    return {
      detail: 'submodule checked out, uv present, python packages warmed',
      lane: 'conformance',
      ready: true,
    }
  }
  if (opts.check) {
    const missing = [
      ...(existsSync(marker) ? [] : ['upstream/llama.cpp is not checked out']),
      ...(haveUv ? [] : ['uv is not on PATH']),
    ]
    return {
      detail:
        `${missing.join('; ')}; ` +
        '`pnpm run setup:e2e --conformance` fixes what it can',
      lane: 'conformance',
      ready: false,
    }
  }
  if (!haveUv) {
    return {
      detail:
        'uv is not on PATH, and setup does not install it — the fleet ' +
        'security-tools wizard owns that',
      lane: 'conformance',
      ready: false,
    }
  }
  logger.info('checking out upstream/llama.cpp…')
  await spawn(
    'node',
    [
      path.join(REPO_ROOT, 'scripts', 'fleet', 'git-partial-submodule.mts'),
      'clone',
      'upstream/llama.cpp',
    ],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  )
  if (!existsSync(marker)) {
    return {
      detail: 'the submodule clone left no tools/server/tests/utils.py',
      lane: 'conformance',
      ready: false,
    }
  }
  await warmPythonEnv()
  return {
    detail: 'submodule checked out, python packages warmed',
    lane: 'conformance',
    ready: true,
  }
}

export async function hasUv(): Promise<boolean> {
  try {
    await spawn('uv', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the pinned python packages once, so the first conformance run does
 * not pay for the download inside a test timeout.
 */
export async function warmPythonEnv(): Promise<void> {
  logger.info('warming the pinned python packages…')
  const args = ['run', '--python', PYTHON_VERSION]
  for (let i = 0, { length } = PYTHON_PINS; i < length; i += 1) {
    args.push('--with', PYTHON_PINS[i]!)
  }
  args.push('python', '-c', 'import pytest, requests, openai, wget, aiohttp')
  await spawn('uv', args, { cwd: REPO_ROOT, stdio: 'inherit' })
}

export async function runLane(
  lane: LaneName,
  options: LaneOptions,
): Promise<LaneStatus> {
  if (lane === 'chrome') {
    return await chromeLane(options)
  }
  if (lane === 'model') {
    return await modelLane(options)
  }
  return await conformanceLane(options)
}

/**
 * Report the lanes and name the command each gated test needs. In `--check`
 * mode a missing lane is information, not a failure: a fresh clone should not
 * fail its install over an optional 4 GB download.
 */
export function reportLanes(
  statuses: readonly LaneStatus[],
  options: LaneOptions,
): number {
  const opts = { __proto__: null, ...options } as typeof options
  for (let i = 0, { length } = statuses; i < length; i += 1) {
    const status = statuses[i]!
    logger.log(
      `  ${status.lane}: ${status.ready ? 'ready' : 'MISSING'} — ${status.detail}`,
    )
  }
  const ready = statuses.every(status => status.ready)
  if (ready) {
    logger.log(
      '\nRun the gated lanes:\n' +
        '  ODAI_E2E=1 pnpm test test/backends/chrome-builtin.test.mts\n' +
        '  ODAI_CONFORMANCE=1 pnpm test test/integration\n' +
        '  pnpm run test:conformance',
    )
  }
  return opts.check || ready ? 0 : 1
}

async function main(): Promise<number> {
  const { check, lanes } = parseSetupArgs(process.argv.slice(2))
  logger.log(check ? 'odai optional test lanes:' : 'provisioning test lanes:')
  const statuses: LaneStatus[] = []
  for (let i = 0, { length } = lanes; i < length; i += 1) {
    statuses.push(await runLane(lanes[i]!, { check }))
  }
  return reportLanes(statuses, { check })
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'provisions the opt-in e2e lanes: real Chrome, the on-device model component, and the llama.cpp conformance prerequisites',
  help: 'Usage: node test/scripts/setup-e2e.mts [--check] [--chrome] [--model] [--conformance]',
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
