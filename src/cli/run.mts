/**
 * @file Locai CLI core. Single-shot subcommands over the backend seam:
 *   summarize, commit-msg, triage, patch, plus a backends availability probe.
 *   Node-only — the bin entry wraps `runCli`, tests call it directly with
 *   injected writers and backends. Failure modes are loud and bounded: a
 *   missing model prints exactly how to provision one and exits 69, the
 *   clean-skip signal, and every prompt runs under a hard timeout so a wedged
 *   engine can never hang a CI job.
 */

import { joinOr } from '@socketsecurity/lib/arrays/join'
import { errorMessage } from '@socketsecurity/lib/errors/message'
import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

import {
  backendNames,
  createBackend,
  selectBackend,
} from '../backends/registry.mts'
import { createLocaiModel } from '../model.mts'
import { classifyDependencyChange } from '../tasks/classify-deps.mts'
import { suggestCommitMessage } from '../tasks/commit.mts'
import { generateCodePatch } from '../tasks/patch.mts'
import { summarizeText } from '../tasks/summarize.mts'
import { triageAlerts } from '../tasks/triage.mts'
import { CliUsageError, parseCliArgs, usageText } from './args.mts'
import type { CliArgs, CliCommand } from './args.mts'
import type {
  BackendAvailability,
  BackendName,
  LocaiBackend,
} from '../backends/types.mts'
import type { LocaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export const EXIT_OK = 0
export const EXIT_TASK_FAILURE = 1
export const EXIT_USAGE = 2
/**
 * Sysexits EX_UNAVAILABLE. A fleet CI step that sees this code skips its AI
 * leg cleanly instead of failing the job.
 */
export const EXIT_NO_BACKEND = 69

export const DEFAULT_PROMPT_TIMEOUT_MS = 120_000
export const LOCAI_TIMEOUT_ENV_VAR = 'LOCAI_TIMEOUT_MS'

const RAW_REPLY_LOG_LIMIT = 400

/**
 * A prompt that blew its time budget. The runner reports it as a task
 * failure with the budget and the knobs that raise it.
 */
export class CliTimeoutError extends Error {}

export type LineWriter = (line: string) => void

export interface RunCliOptions {
  /**
   * Backend instance override. Wins over the --backend flag; the test seam.
   */
  backend?: LocaiBackend | undefined
  /**
   * Env source, `process.env` by default. Injectable for tests.
   */
  env?: Record<string, string | undefined> | undefined
  /**
   * Backends the `backends` command probes. Defaults to every declared
   * registry backend; injectable so tests avoid live probes.
   */
  probeBackends?: LocaiBackend[] | undefined
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
}

export async function closeBackend(
  backend: LocaiBackend | undefined,
): Promise<void> {
  const closeable = backend as
    | { close?: (() => Promise<void>) | undefined }
    | undefined
  await closeable?.close?.().catch(() => undefined)
}

export function promptTimeoutMs(
  args: CliArgs,
  env: Record<string, string | undefined>,
): number {
  if (args.timeoutMs !== undefined) {
    return args.timeoutMs
  }
  const raw = env[LOCAI_TIMEOUT_ENV_VAR]
  if (raw === undefined || raw === '') {
    return DEFAULT_PROMPT_TIMEOUT_MS
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUsageError(
      `locai: ${LOCAI_TIMEOUT_ENV_VAR}="${raw}" is not a positive number of ` +
        'milliseconds.',
    )
  }
  return parsed
}

export function provisioningHelp(): string {
  return [
    'Provisioning:',
    '  gemini-nano-headless — install Google Chrome; when the machine’s Chrome',
    '    already has the Gemini Nano component the bridge clones it with zero',
    '    downloads. In CI point LOCAI_NANO_USER_DATA_DIR at a cached path and run',
    '    one fill job with LOCAI_NANO_ALLOW_DOWNLOAD=1; later jobs restore the',
    '    cached profile and work offline.',
    '  llama-server — start a loopback llama-server and set LOCAI_LLAMA_URL; the',
    '    default probe target is http://127.0.0.1:8080.',
    '  apple-fm — needs Apple silicon with Apple Intelligence enabled.',
    '  simulator — set LOCAI_BACKEND=simulator for deterministic canned replies.',
    'Exit code 69 is the clean-skip signal: a CI step that sees it should skip',
    'its AI leg, never fail the job.',
  ].join('\n')
}

export async function readInputText(
  args: CliArgs,
  readStdin: (() => Promise<string>) | undefined,
): Promise<string> {
  if (args.input !== undefined) {
    const { readFile } = await import('node:fs/promises')
    try {
      return await readFile(args.input, 'utf8')
    } catch (error) {
      throw new CliUsageError(
        `locai: cannot read --input ${args.input}: ${errorMessage(error)}`,
      )
    }
  }
  if (readStdin !== undefined) {
    return await readStdin()
  }
  if (process.stdin.isTTY) {
    throw new CliUsageError(
      'locai: nothing to read — pass --input <path> or pipe content on stdin.',
    )
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function runBackendsCommand(
  probeBackends: LocaiBackend[] | undefined,
  stdout: LineWriter,
): Promise<number> {
  const backends =
    probeBackends ?? backendNames.map(name => createBackend(name))
  const rows: Array<{
    available: boolean
    name: BackendName
    reason?: string | undefined
  }> = []
  for (const backend of backends) {
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

export async function runCli(
  argv: string[],
  options?: RunCliOptions | undefined,
): Promise<number> {
  const opts = { __proto__: null, ...options } as RunCliOptions
  const logger = getDefaultLogger()
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
    stderr('locai: no command given.')
    stderr(usageText())
    return EXIT_USAGE
  }
  if (command === 'backends') {
    return await runBackendsCommand(opts.probeBackends, stdout)
  }

  let input: string
  try {
    input = await readInputText(args, opts.readStdin)
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr(error.message)
      return EXIT_USAGE
    }
    throw error
  }
  if (input.trim() === '') {
    stderr(`locai ${command}: the input is empty.`)
    return EXIT_USAGE
  }

  let backend: LocaiBackend
  try {
    backend = await selectBackend({
      backend: opts.backend ?? args.backend,
      env,
    })
  } catch (error) {
    stderr(`locai ${command}: no usable backend — ${errorMessage(error)}`)
    stderr(provisioningHelp())
    return EXIT_NO_BACKEND
  }

  try {
    const model = await createLocaiModel({
      backend,
      temperature: 0,
      topK: 1,
    })
    const result = await withTimeout(
      runTask(command, model, input, args.instruction),
      timeoutMs,
      `locai ${command}: the ${backend.name} prompt`,
    )
    if (result.ok && result.data !== undefined) {
      stdout(args.raw ? result.raw : JSON.stringify(result.data))
      return EXIT_OK
    }
    stderr(
      `locai ${command}: the ${backend.name} reply failed validation — ` +
        (result.error ?? 'no parse error recorded'),
    )
    stderr(`raw reply: ${truncateForLog(result.raw)}`)
    return EXIT_TASK_FAILURE
  } catch (error) {
    stderr(`locai ${command}: ${errorMessage(error)}`)
    return EXIT_TASK_FAILURE
  } finally {
    await closeBackend(backend)
  }
}

export async function runTask(
  command: CliCommand,
  model: LocaiModel,
  input: string,
  instruction: string | undefined,
): Promise<TaskResult<unknown>> {
  switch (command) {
    case 'classify-deps':
      return await classifyDependencyChange(model, input)
    case 'commit-msg':
      return await suggestCommitMessage(model, input)
    case 'patch': {
      if (instruction === undefined) {
        throw new CliUsageError(
          'locai: patch needs --instruction <text> describing the change.',
        )
      }
      return await generateCodePatch(model, input, instruction)
    }
    case 'summarize':
      return await summarizeText(model, input)
    case 'triage':
      return await triageAlerts(model, input)
    default:
      throw new CliUsageError(
        `locai: "${command}" is not a prompt command; expected ` +
          `${joinOr(['classify-deps', 'commit-msg', 'patch', 'summarize', 'triage'])}.`,
      )
  }
}

export function truncateForLog(value: string): string {
  if (value.length <= RAW_REPLY_LOG_LIMIT) {
    return value
  }
  return `${value.slice(0, RAW_REPLY_LOG_LIMIT)}…`
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new CliTimeoutError(
          `${label} did not finish within ${timeoutMs}ms. Raise --timeout or ` +
            `${LOCAI_TIMEOUT_ENV_VAR}; a CPU-only backend can need several ` +
            'minutes for its first prompt.',
        ),
      )
    }, timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(errorMessage(error)))
      },
    )
  })
}
