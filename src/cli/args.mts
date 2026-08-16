/**
 * @file Argument parsing for the odai CLI. Pure and synchronous so tests
 *   exercise every path without a process boundary.
 */

import { joinOr } from '@socketsecurity/lib/arrays/join'

import { backendNames, isBackendName } from '../backends/registry.mts'
import type { BackendName } from '../backends/types.mts'

export const CLI_COMMANDS = [
  'backends',
  'batch',
  'classify-deps',
  'commit-msg',
  'dedupe',
  'hoist',
  'lockfile',
  'patch',
  'security-fix',
  'serve',
  'summarize',
  'triage',
  'weekly-update',
] as const

export type CliCommand = (typeof CLI_COMMANDS)[number]

export interface CliArgs {
  backend: BackendName | undefined
  command: CliCommand | undefined
  help: boolean
  input: string | undefined
  instruction: string | undefined
  port: number | undefined
  raw: boolean
  timeoutMs: number | undefined
}

/**
 * A CLI invocation the parser rejects: unknown command or flag, missing flag
 * value, or a flag that contradicts the command. The runner prints the
 * message plus usage and exits 2.
 */
export class CliUsageError extends Error {}

const MAX_PORT = 65_535

export function isCliCommand(value: string): value is CliCommand {
  return (CLI_COMMANDS as readonly string[]).includes(value)
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    backend: undefined,
    command: undefined,
    help: false,
    input: undefined,
    instruction: undefined,
    port: undefined,
    raw: false,
    timeoutMs: undefined,
  }
  const takeValue = (
    flag: string,
    inline: string | undefined,
    next: () => string | undefined,
  ): string => {
    if (inline !== undefined) {
      return inline
    }
    const value = next()
    if (value === undefined) {
      throw new CliUsageError(`odai: ${flag} needs a value.`)
    }
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    const eq = token.indexOf('=')
    const flag =
      token.startsWith('--') && eq !== -1 ? token.slice(0, eq) : token
    const inline =
      token.startsWith('--') && eq !== -1 ? token.slice(eq + 1) : undefined
    const next = (): string | undefined => {
      i += 1
      return argv[i]
    }
    switch (flag) {
      case '--backend': {
        const value = takeValue(flag, inline, next)
        if (!isBackendName(value)) {
          throw new CliUsageError(
            `odai: --backend ${value} is not a declared backend; expected ` +
              `${joinOr([...backendNames])}.`,
          )
        }
        args.backend = value
        break
      }
      case '--help':
      case '-h': {
        args.help = true
        break
      }
      case '--input': {
        args.input = takeValue(flag, inline, next)
        break
      }
      case '--instruction': {
        args.instruction = takeValue(flag, inline, next)
        break
      }
      case '--port': {
        const value = takeValue(flag, inline, next)
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PORT) {
          throw new CliUsageError(`odai: --port ${value} is not a valid port.`)
        }
        args.port = parsed
        break
      }
      case '--raw': {
        args.raw = true
        break
      }
      case '--timeout': {
        const value = takeValue(flag, inline, next)
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new CliUsageError(
            `odai: --timeout ${value} is not a positive number of milliseconds.`,
          )
        }
        args.timeoutMs = parsed
        break
      }
      default: {
        if (token.startsWith('-')) {
          throw new CliUsageError(`odai: unknown option ${token}.`)
        }
        if (args.command !== undefined) {
          throw new CliUsageError(
            `odai: unexpected argument "${token}" after the ${args.command} command.`,
          )
        }
        if (!isCliCommand(token)) {
          throw new CliUsageError(
            `odai: unknown command "${token}"; expected ${joinOr([...CLI_COMMANDS])}.`,
          )
        }
        args.command = token
      }
    }
  }
  if (
    args.command === 'patch' &&
    !args.help &&
    args.instruction === undefined
  ) {
    throw new CliUsageError(
      'odai: patch needs --instruction <text> describing the change.',
    )
  }
  if (
    args.instruction !== undefined &&
    args.command !== undefined &&
    args.command !== 'patch'
  ) {
    throw new CliUsageError(
      `odai: --instruction only applies to the patch command, not ${args.command}.`,
    )
  }
  if (
    args.port !== undefined &&
    args.command !== undefined &&
    args.command !== 'serve'
  ) {
    throw new CliUsageError(
      `odai: --port only applies to the serve command, not ${args.command}.`,
    )
  }
  if (args.raw && args.command === 'batch') {
    throw new CliUsageError(
      'odai: --raw does not apply to the batch command — batch output is always JSONL.',
    )
  }
  return args
}

export function usageText(): string {
  return [
    'Usage: odai <command> [options]',
    '',
    'Single-shot, keyless, on-device AI. Input arrives on stdin or --input;',
    'the parsed result prints as one JSON line on stdout.',
    '',
    'Commands:',
    '  backends              probe every declared backend, print availability JSON',
    '  batch                 run many tasks from a JSONL manifest over one backend launch',
    '  classify-deps         flag a narrowed dependency diff as routine or surprise',
    '  commit-msg            suggest a Conventional Commits subject for a diff',
    '  dedupe                which package versions collapse safely (JSON stdin)',
    '  hoist                 assess a cross-major hoist from a changelog (JSON stdin)',
    '  lockfile              reason about a lockfile excerpt',
    '  patch                 generate a unified-diff code patch for a file',
    '  security-fix          pick the minimal safe upgrade for an advisory (JSON stdin)',
    '  serve                 listen on loopback for Anthropic Messages API requests',
    '  summarize             condense text into a summary plus key points',
    '  triage                explain aggregate security findings in plain language',
    '  weekly-update         plan soak-gated dependency updates (JSON stdin)',
    '',
    'Options:',
    `  --backend <name>      pick a backend: ${backendNames.join(', ')};`,
    '                        default: ODAI_BACKEND env var, then the availability probe',
    '  --input <path>        read input from a file instead of stdin',
    '  --instruction <text>  the change patch should make; required for patch',
    '  --port <n>            loopback port for serve; default 8402, 0 picks a free port',
    '  --raw                 print the raw model reply instead of the parsed JSON',
    '  --timeout <ms>        per-prompt budget; default 120000, env ODAI_TIMEOUT_MS',
    '  -h, --help            show this help',
    '',
    'Exit codes: 0 success, 1 model or task failure, 2 usage error,',
    '69 no backend available — CI steps treat 69 as a clean skip.',
  ].join('\n')
}
