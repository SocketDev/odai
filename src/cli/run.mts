/**
 * @file Odai CLI core. Single-shot prompt subcommands over the backend
 *   interface (see CLI_COMMANDS — text tasks take stdin; the structured
 *   dep-update tasks dedupe / hoist / security-fix / weekly-update take a JSON
 *   object on stdin), plus a backends availability probe and the serve loopback
 *   shim. Node-only — the bin entry wraps `runCli`, tests call it directly with
 *   injected writers and backends. Failure modes are loud and bounded: a
 *   missing model prints exactly how to provision one and exits 69, the
 *   clean-skip signal, and every prompt runs under a hard timeout so an
 *   unresponsive engine can never hang a CI job.
 */

import { errorMessage } from '@socketsecurity/lib/errors/message'
import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

import {
  backendNames,
  createBackend,
  selectBackend,
} from '../backends/registry.mts'
import { preferredTaskBackend } from '../routing.mts'
import { parseLockstepInput } from '../lockstep/validate.mts'
import { parseJsonInput } from './dispatch.mts'
import { createOdaiModel, destroySession } from '../model.mts'
import type { OdaiModel } from '../model.mts'
import {
  closeBackend,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_SERVE_PORT,
  EXIT_NO_BACKEND,
  EXIT_OK,
  EXIT_TASK_FAILURE,
  EXIT_USAGE,
  ODAI_TIMEOUT_ENV_VAR,
  readInputText,
  truncateForLog,
  withTimeout,
} from './runtime.mts'
import type { LineWriter } from './runtime.mts'
import { runServeCommand } from './serve.mts'
import { setupChromeBuiltin } from '../backends/chrome/setup.mts'
import type { ChromeSetupReceipt } from '../backends/chrome/setup.mts'
export {
  CliTimeoutError,
  closeBackend,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_SERVE_PORT,
  EXIT_NO_BACKEND,
  EXIT_OK,
  EXIT_TASK_FAILURE,
  EXIT_USAGE,
  ODAI_TIMEOUT_ENV_VAR,
  readInputText,
  truncateForLog,
  withTimeout,
} from './runtime.mts'
export type { LineWriter } from './runtime.mts'
export { runServeCommand } from './serve.mts'
export type { RunServeCommandOptions } from './serve.mts'
import { CliUsageError, parseCliArgs, usageText } from './args.mts'
import { parseBatchManifest, runBatchEntries } from './batch.mts'
import { runTask } from './dispatch.mts'
import type { CliArgs } from './args.mts'
import type { TaskCommand } from './commands.mts'
import type { ShimServerHandle } from '../shim/server.mts'
import type { BatchEntry } from './batch.mts'
import type {
  BackendAvailability,
  BackendName,
  OdaiBackend,
} from '../backends/types.mts'

const logger = getDefaultLogger()

export interface RunCliOptions {
  /**
   * Backend instance override. Wins over the --backend flag; the test injection
   * point.
   */
  backend?: OdaiBackend | undefined
  /**
   * Env source, `process.env` by default. Injectable for tests.
   */
  env?: Record<string, string | undefined> | undefined
  /**
   * Called once the serve shim is listening; the test injection point for
   * learning the bound port.
   */
  onServeStart?: ((handle: ShimServerHandle) => void) | undefined
  /**
   * Backends the `backends` command probes. Defaults to every declared
   * registry backend; injectable so tests avoid live probes.
   */
  probeBackends?: OdaiBackend[] | undefined
  /**
   * Stdin reader override. Defaults to draining `process.stdin`.
   */
  readStdin?: (() => Promise<string>) | undefined
  /**
   * Diagnostic line sink, the default logger's error stream by default.
   */
  stderr?: LineWriter | undefined
  /**
   * Result line sink, the default logger's log stream by default.
   */
  stdout?: LineWriter | undefined
  /**
   * Serve-stop signal override. Defaults to a promise resolving on
   * SIGINT/SIGTERM; tests resolve it themselves instead of signalling the
   * process.
   */
  stopServing?: Promise<void> | undefined
  /**
   * Chrome setup override for tests and hosts that wrap provisioning.
   */
  setupChrome?:
    | ((options: {
        env: Record<string, string | undefined>
      }) => Promise<ChromeSetupReceipt>)
    | undefined
}

export function promptTimeoutMs(
  args: CliArgs,
  env: Record<string, string | undefined>,
): number {
  if (args.timeoutMs !== undefined) {
    return args.timeoutMs
  }
  const raw = env[ODAI_TIMEOUT_ENV_VAR]
  if (raw === undefined || raw === '') {
    return DEFAULT_PROMPT_TIMEOUT_MS
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUsageError(
      `odai: ${ODAI_TIMEOUT_ENV_VAR}="${raw}" is not a positive number of ` +
        'milliseconds.',
    )
  }
  return parsed
}

export function provisioningHelp(): string {
  return [
    'Provisioning:',
    '  chrome-builtin — install Google Chrome; when the machine’s Chrome',
    '    already has the on-device model component the bridge clones it with',
    '    zero downloads. In CI point ODAI_CHROME_USER_DATA_DIR at a cached path',
    '    and run one fill job with ODAI_CHROME_ALLOW_DOWNLOAD=1; later jobs',
    '    restore the cached profile and work offline.',
    '  llama-server — start a loopback llama-server and set ODAI_LLAMA_URL; the',
    '    default probe target is http://127.0.0.1:8080.',
    '  apple-fm — needs Apple silicon with Apple Intelligence enabled.',
    '  simulator — set ODAI_BACKEND=simulator for deterministic canned replies.',
    'Exit code 69 is the clean-skip signal: a CI step that sees it should skip',
    'its AI leg, never fail the job.',
  ].join('\n')
}

export async function readCliTaskInput(
  context: CliContext,
  command: TaskCommand | 'batch',
): Promise<{ input: string; batchEntries: BatchEntry[] | undefined }> {
  const input = await readInputText(context.args, context.options.readStdin)
  if (input.trim() === '') {
    throw new CliUsageError(`odai ${command}: the input is empty.`)
  }
  const prepared = {
    __proto__: null,
    input,
    batchEntries: command === 'batch' ? parseBatchManifest(input) : undefined,
  }
  return prepared
}

export async function runBackendsCommand(
  probeBackends: OdaiBackend[] | undefined,
  stdout: LineWriter,
): Promise<number> {
  const backends =
    probeBackends ?? backendNames.map(name => createBackend(name))
  const rows: Array<{
    available: boolean
    name: BackendName
    reason?: string | undefined
  }> = []
  for (let i = 0, { length } = backends; i < length; i += 1) {
    const backend = backends[i]!
    let availability: BackendAvailability
    try {
      availability = await backend.availability()
    } catch (error) {
      availability = { available: false, reason: errorMessage(error) }
    }
    rows.push({
      available: availability.available,
      name: backend.name,
      ...(availability.reason === undefined
        ? {}
        : { reason: availability.reason }),
    })
    await closeBackend(backend)
  }
  stdout(JSON.stringify({ backends: rows }, undefined, 2))
  return rows.some(row => row.available) ? EXIT_OK : EXIT_NO_BACKEND
}

export async function runBatchCommand(
  backend: OdaiBackend,
  entries: BatchEntry[],
  timeoutMs: number,
  stdout: LineWriter,
  stderr: LineWriter,
): Promise<number> {
  let model: OdaiModel | undefined
  try {
    model = await createOdaiModel({ backend, temperature: 0, topK: 1 })
    await runBatchEntries(model, entries, timeoutMs, stdout)
    return EXIT_OK
  } catch (error) {
    stderr(`odai batch: ${errorMessage(error)}`)
    return EXIT_TASK_FAILURE
  } finally {
    if (model !== undefined) {
      destroySession(model.rawSession())
    }
    await closeBackend(backend)
  }
}

export interface CliContext {
  args: CliArgs
  env: Record<string, string | undefined>
  options: RunCliOptions
  stderr: LineWriter
  stdout: LineWriter
  timeoutMs: number
}

export async function runCli(
  argv: string[],
  options?: RunCliOptions | undefined,
): Promise<number> {
  const opts = { __proto__: null, ...options } as RunCliOptions
  const stdout = opts.stdout ?? ((line: string) => logger.log(line))
  const stderr = opts.stderr ?? ((line: string) => logger.error(line))
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  let args: CliArgs
  let timeoutMs: number
  try {
    args = parseCliArgs(argv)
    timeoutMs = promptTimeoutMs(args, env)
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr(error.message)
      stderr(usageText())
      return EXIT_USAGE
    }
    throw error
  }
  if (args.help) {
    stdout(usageText())
    return EXIT_OK
  }
  const command = args.command
  if (command === undefined) {
    stderr('odai: no command given.')
    stderr(usageText())
    return EXIT_USAGE
  }
  if (command === 'backends') {
    return await runBackendsCommand(opts.probeBackends, stdout)
  }
  if (command === 'setup') {
    if (args.backend !== undefined && args.backend !== 'chrome-builtin') {
      stderr('odai setup: --backend must be chrome-builtin.')
      return EXIT_USAGE
    }
    try {
      const receipt = await (opts.setupChrome ?? setupChromeBuiltin)({ env })
      stdout(JSON.stringify(receipt))
      return EXIT_OK
    } catch (error) {
      stderr(`odai setup: ${errorMessage(error)}`)
      return EXIT_TASK_FAILURE
    }
  }
  const context: CliContext = {
    args,
    env,
    options: opts,
    stderr,
    stdout,
    timeoutMs,
  }
  if (command === 'serve') {
    return await runConfiguredServe(context)
  }
  return await runInputCommand(context, command)
}

export async function runConfiguredServe(context: CliContext): Promise<number> {
  const { args, env, options, stderr } = context
  let backend: OdaiBackend
  try {
    backend = await selectBackend({
      backend: options.backend ?? args.backend,
      env,
    })
  } catch (error) {
    stderr(`odai serve: no usable backend — ${errorMessage(error)}`)
    stderr(provisioningHelp())
    return EXIT_NO_BACKEND
  }
  return await runServeCommand(
    backend,
    args.port ?? DEFAULT_SERVE_PORT,
    stderr,
    {
      onStart: options.onServeStart,
      stop: options.stopServing,
    },
  )
}

export async function runConfiguredTask(
  context: CliContext,
  command: TaskCommand,
  input: string,
  backend: OdaiBackend,
): Promise<number> {
  const { args, stderr, stdout, timeoutMs } = context
  let model: OdaiModel | undefined
  try {
    model = await createOdaiModel({ backend, temperature: 0, topK: 1 })
    const result = await withTimeout(
      runTask(command, model, input, args.instruction),
      timeoutMs,
      `odai ${command}: the ${backend.name} prompt`,
    )
    if (result.ok && result.data !== undefined) {
      stdout(args.raw ? result.raw : JSON.stringify(result.data))
      return EXIT_OK
    }
    stderr(
      `odai ${command}: the ${backend.name} reply failed validation — ${result.error ?? 'no parse error recorded'}`,
    )
    stderr(`raw reply: ${truncateForLog(result.raw)}`)
    return EXIT_TASK_FAILURE
  } catch (error) {
    stderr(`odai ${command}: ${errorMessage(error)}`)
    return EXIT_TASK_FAILURE
  } finally {
    if (model !== undefined) {
      destroySession(model.rawSession())
    }
    await closeBackend(backend)
  }
}

export async function runInputCommand(
  context: CliContext,
  command: TaskCommand | 'batch',
): Promise<number> {
  const { stderr, stdout, timeoutMs } = context
  let prepared: Awaited<ReturnType<typeof readCliTaskInput>>
  try {
    prepared = await readCliTaskInput(context, command)
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr(error.message)
      return EXIT_USAGE
    }
    throw error
  }
  const { input, batchEntries } = prepared
  try {
    validateCliLockstepInputs(input, command, batchEntries)
  } catch (error) {
    stderr(`odai ${command}: invalid lockstep input — ${errorMessage(error)}`)
    return EXIT_USAGE
  }
  let backend: OdaiBackend
  try {
    backend = await selectCliBackend(
      context,
      batchEntries?.map(entry => entry.task) ?? [command],
    )
  } catch (error) {
    stderr(`odai ${command}: no usable backend — ${errorMessage(error)}`)
    stderr(provisioningHelp())
    return EXIT_NO_BACKEND
  }
  if (batchEntries !== undefined) {
    return await runBatchCommand(
      backend,
      batchEntries,
      timeoutMs,
      stdout,
      stderr,
    )
  }
  return await runConfiguredTask(
    context,
    command as TaskCommand,
    input,
    backend,
  )
}

export async function selectCliBackend(
  context: CliContext,
  tasks: readonly string[],
): Promise<OdaiBackend> {
  return await selectBackend({
    backend:
      context.options.backend ??
      context.args.backend ??
      (context.env['ODAI_BACKEND'] ? undefined : preferredTaskBackend(tasks)),
    env: context.env,
  })
}

export function validateCliLockstepInputs(
  input: string,
  command: TaskCommand | 'batch',
  batchEntries: BatchEntry[] | undefined,
): void {
  const inputs =
    batchEntries === undefined
      ? command === 'lockstep'
        ? [input]
        : []
      : batchEntries
          .filter(entry => entry.task === 'lockstep')
          .map(entry => entry.input)
  for (let i = 0, { length } = inputs; i < length; i += 1) {
    parseLockstepInput(
      parseJsonInput(
        inputs[i]!,
        'lockstep',
        '{ version: 1, row, evidence, truncated }',
      ),
    )
  }
}
