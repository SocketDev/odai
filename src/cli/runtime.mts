import { errorMessage } from '@socketsecurity/lib/errors/message'

import { CliUsageError } from './args.mts'
import type { CliArgs } from './args.mts'
import type { OdaiBackend } from '../backends/types.mts'

export const EXIT_OK = 0
export const EXIT_TASK_FAILURE = 1
export const EXIT_USAGE = 2
/**
 * Sysexits EX_UNAVAILABLE. A fleet CI step that sees this code skips its AI
 * leg cleanly instead of failing the job.
 */
export const EXIT_NO_BACKEND = 69

export const DEFAULT_PROMPT_TIMEOUT_MS = 120_000
export const DEFAULT_SERVE_PORT = 8402
export const ODAI_TIMEOUT_ENV_VAR = 'ODAI_TIMEOUT_MS'

const RAW_REPLY_LOG_LIMIT = 400

/**
 * A prompt that blew its time budget. The runner reports it as a task
 * failure with the budget and the knobs that raise it.
 */
export class CliTimeoutError extends Error {}

export type LineWriter = (line: string) => void

export async function closeBackend(
  backend: OdaiBackend | undefined,
): Promise<void> {
  const closeable = backend as
    | { close?: (() => Promise<void>) | undefined }
    | undefined
  await closeable?.close?.().catch(() => undefined)
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
        `odai: cannot read --input ${args.input}: ${errorMessage(error)}`,
      )
    }
  }
  if (readStdin !== undefined) {
    return await readStdin()
  }
  if (process.stdin.isTTY) {
    throw new CliUsageError(
      'odai: nothing to read — pass --input <path> or pipe content on stdin.',
    )
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
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
            `${ODAI_TIMEOUT_ENV_VAR}; a CPU-only backend can need several ` +
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
