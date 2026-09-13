/**
 * @file Argument parsing for the odai CLI. Pure and synchronous so tests
 *   exercise every path without a process boundary.
 */

import { joinOr } from '@socketsecurity/lib/arrays/join'

import { backendNames, isBackendName } from '../backends/registry.mts'
import { TASK_COMMANDS, TASK_NAMES } from './commands.mts'
import type { TaskCommand } from './commands.mts'
import type { BackendName } from '../backends/types.mts'

export const CLI_COMMANDS = [
  'backends',
  'batch',
  'setup',
  ...TASK_NAMES,
  'serve',
].toSorted()

export type CliCommand = TaskCommand | 'backends' | 'batch' | 'serve' | 'setup'

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

export function assignCliArgument(
  args: CliArgs,
  token: string,
  next: () => string | undefined,
): void {
  const eq = token.indexOf('=')
  const hasInline = token.startsWith('--') && eq !== -1
  const flag = hasInline ? token.slice(0, eq) : token
  const inline = hasInline ? token.slice(eq + 1) : undefined
  switch (flag) {
    case '--backend':
      args.backend = parseCliBackend(takeCliValue(flag, inline, next))
      break
    case '--help':
    case '-h':
      args.help = true
      break
    case '--input':
      args.input = takeCliValue(flag, inline, next)
      break
    case '--instruction':
      args.instruction = takeCliValue(flag, inline, next)
      break
    case '--port':
      args.port = parseCliPort(takeCliValue(flag, inline, next))
      break
    case '--raw':
      args.raw = true
      break
    case '--timeout':
      args.timeoutMs = parseCliTimeout(takeCliValue(flag, inline, next))
      break
    default:
      assignCliCommand(args, token)
  }
}

export function assignCliCommand(args: CliArgs, token: string): void {
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
  for (let i = 0, { length } = argv; i < length; i += 1) {
    assignCliArgument(args, argv[i]!, () => {
      i += 1
      return argv[i]
    })
  }
  validateCliArgs(args)
  return args
}

export function parseCliBackend(value: string): BackendName {
  if (!isBackendName(value)) {
    throw new CliUsageError(
      `odai: --backend ${value} is not a declared backend; expected ${joinOr([...backendNames])}.`,
    )
  }
  return value
}

export function parseCliPort(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PORT) {
    throw new CliUsageError(
      `odai: --port ${value} is not a valid port; expected an integer from 0 to ${MAX_PORT} (0 lets the OS pick a free port).`,
    )
  }
  return parsed
}

export function parseCliTimeout(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUsageError(
      `odai: --timeout ${value} is not a positive number of milliseconds.`,
    )
  }
  return parsed
}

export function takeCliValue(
  flag: string,
  inline: string | undefined,
  next: () => string | undefined,
): string {
  if (inline !== undefined) {
    return inline
  }
  const value = next()
  if (value === undefined) {
    throw new CliUsageError(`odai: ${flag} needs a value.`)
  }
  return value
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
    '  setup                 prepare and verify the persistent Chrome model profile',
    ...TASK_NAMES.map(
      name => `  ${name.padEnd(22)}${TASK_COMMANDS[name].description}`,
    ),
    '  serve                 listen on loopback for Anthropic Messages and OpenAI chat requests',
    '',
    'Options:',
    `  --backend <name>      pick a backend: ${backendNames.join(', ')};`,
    '                        default: ODAI_BACKEND, then llama-server for lockstep/patch,',
    '                        otherwise the availability probe. Use chrome-builtin to evaluate Gemma.',
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

export function validateCliArgs(args: CliArgs): void {
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
}
