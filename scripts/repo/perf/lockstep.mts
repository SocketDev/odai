import process from 'node:process'
import { parseArgs } from 'node:util'
import { stringify, writeJson } from '@socketsecurity/lib-stable/fs/write-json'
import { errorMessage } from '@socketsecurity/lib-stable/errors/message'

// oxlint-disable-next-line socket/prefer-stable-self-import -- benchmark
import { startBridge } from '../../../src/backends/chrome-builtin.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- benchmark
import { createPageBoundFactory } from '../../../src/backends/chrome-page.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- benchmark
import { createLockstepScenario } from '../../../src/bench/lockstep/scenarios.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- benchmark
import { awaitCancellable } from '../../../src/cancellation.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- benchmark
import { withTimeout } from '../../../src/cli/runtime.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- benchmark
import { createModelFromState, destroySession } from '../../../src/model.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- benchmark
import { detectModelName } from '../../../src/model-identity.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- benchmark
import {
  LOCKSTEP_FEW_SHOT,
  LOCKSTEP_SYSTEM_PROMPT,
} from '../../../src/prompts/lockstep.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- benchmark
import type {
  LanguageModelLike,
  Message,
  SessionLike,
} from '../../../src/types.mts'
import { isMainModule } from '../../fleet/process/is-main-module.mts'
import { runMain } from '../../fleet/process/run-main.mts'

export interface LockstepAttempt {
  durationMs: number
  inputCharacters: number
  outputCharacters: number
  completed: boolean
  raw?: string | undefined
  error?: string | undefined
}

export const LOCKSTEP_CONTEXT_PREFIX: Message[] = [
  { role: 'system', content: LOCKSTEP_SYSTEM_PROMPT },
  ...LOCKSTEP_FEW_SHOT,
]

export type LockstepContextMode = 'per-request' | 'preloaded'

export interface LockstepArguments {
  help: boolean
  mode: LockstepContextMode | 'both'
  output?: string | undefined
  pairs: number
  timeoutMs: number
}

export interface LockstepExperimentOptions {
  mode?: LockstepContextMode | 'both' | undefined
}

export function lockstepExperimentOrder(
  pair: number,
  options: LockstepExperimentOptions = {},
): Array<{
  mode: LockstepContextMode
  materializations: Array<'full' | 'sparse'>
}> {
  const opts = { __proto__: null, ...options }
  const selection = opts.mode ?? 'per-request'
  const modes: LockstepContextMode[] =
    pair % 2 === 0 ? ['per-request', 'preloaded'] : ['preloaded', 'per-request']
  return modes
    .filter(mode => selection === 'both' || selection === mode)
    .map(mode => ({
      __proto__: null,
      mode,
      materializations:
        pair % 2 === 0 ? ['full', 'sparse'] : ['sparse', 'full'],
    }))
}

export function parseLockstepExperimentArgs(
  argv: string[],
): LockstepArguments & { __proto__: null } {
  const { values } = parseArgs({
    args: argv,
    options: {
      pairs: { type: 'string', default: '3' },
      mode: { type: 'string', default: 'per-request' },
      timeout: { type: 'string', default: '120000' },
      output: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  })
  const pairs = Number(values.pairs)
  const timeoutMs = Number(values.timeout)
  const mode = values.mode
  if (mode !== 'both' && mode !== 'per-request' && mode !== 'preloaded') {
    throw new Error(
      'Invalid lockstep mode. Where: --mode. Wanted per-request, preloaded, or both. Fix: use --mode per-request for production evaluation.',
    )
  }
  if (
    !Number.isSafeInteger(pairs) ||
    pairs < 1 ||
    pairs > 20 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 3_600_000
  ) {
    throw new Error(
      'Invalid lockstep experiment options. Where: arguments. Wanted 1–20 pairs and timeout 1–3600000ms. Fix: use --pairs 3 --timeout 120000.',
    )
  }
  return {
    __proto__: null,
    pairs,
    mode,
    timeoutMs,
    output: values.output,
    help: values.help ?? false,
  }
}

export interface LockstepPrefixOptions {
  prefix?: Message[] | undefined
}

export function stripLockstepPrefix(
  messages: Message[],
  options: LockstepPrefixOptions = {},
): Message[] {
  const opts = { __proto__: null, ...options }
  const prefix = opts.prefix ?? LOCKSTEP_CONTEXT_PREFIX
  if (
    !prefix.every(
      (message, index) =>
        message.role === messages[index]?.role &&
        message.content === messages[index]?.content,
    )
  ) {
    throw new Error(
      'Lockstep prefix mismatch. Where: preloaded experiment. Saw different instructions. Fix: rerun with matching templates; no fallback was applied.',
    )
  }
  return messages.slice(prefix.length)
}

export function traceLockstepSession(
  session: SessionLike,
  mode: LockstepContextMode,
  attempts: LockstepAttempt[],
  timeoutMs: number,
): SessionLike {
  if (typeof session.clone !== 'function') {
    throw new Error(
      'Lockstep experiment needs native cloning. Where: session. Saw no clone method. Fix: use supported Chrome; no shared-session fallback was applied.',
    )
  }
  const wrapped: SessionLike & { __proto__: null } = {
    __proto__: null,
    async clone() {
      const clone = await awaitCancellable(
        Promise.resolve(session.clone!()),
        AbortSignal.timeout(timeoutMs),
        destroySession,
      )
      return traceLockstepSession(clone, mode, attempts, timeoutMs)
    },
    destroy() {
      destroySession(session)
    },
    async prompt(messages, config) {
      const opts = { __proto__: null, ...config }
      const input =
        mode === 'preloaded' ? stripLockstepPrefix(messages) : messages
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal =
        opts?.abortSignal === undefined
          ? timeout
          : AbortSignal.any([timeout, opts.abortSignal])
      const startedAt = performance.now()
      const attempt: LockstepAttempt = {
        durationMs: 0,
        inputCharacters: input.reduce(
          (sum, message) => sum + message.content.length,
          0,
        ),
        outputCharacters: 0,
        completed: false,
      }
      try {
        const result = await awaitCancellable(
          session.prompt(input, { ...opts, abortSignal: signal }),
          signal,
        )
        attempt.outputCharacters = result.length
        attempt.completed = true
        attempt.raw = result
        return result
      } catch (error) {
        attempt.error = errorMessage(error)
        throw error
      } finally {
        attempt.durationMs = performance.now() - startedAt
        attempts.push(attempt)
        if (signal.aborted) {
          destroySession(session)
        }
      }
    },
    promptStreaming() {
      throw new Error(
        'Lockstep experiment uses structured prompt attempts, not streaming.',
      )
    },
  }
  return wrapped
}

export async function runLockstepContextPair(
  factory: LanguageModelLike,
  pair: number,
  timeoutMs: number,
  options: LockstepExperimentOptions = {},
) {
  const opts = { __proto__: null, ...options }
  const rows = []
  for (const { mode, materializations } of lockstepExperimentOrder(
    pair,
    opts,
  )) {
    const contextStartedAt = performance.now()
    const native = await awaitCancellable(
      factory.create(
        mode === 'preloaded'
          ? { initialPrompts: LOCKSTEP_CONTEXT_PREFIX }
          : undefined,
      ),
      AbortSignal.timeout(timeoutMs),
      destroySession,
    )
    try {
      const contextSetupMs = performance.now() - contextStartedAt
      const attempts: LockstepAttempt[] = []
      const session = traceLockstepSession(native, mode, attempts, timeoutMs)
      const model = createModelFromState({
        cloneCapable: true,
        namespace: 'modern',
        session,
      })
      for (const materialization of materializations) {
        attempts.length = 0
        const startedAt = performance.now()
        const result = await withTimeout(
          createLockstepScenario(materialization).run(model),
          timeoutMs * 4,
          'Lockstep scenario',
        )
        rows.push({
          __proto__: null,
          pair,
          mode,
          materialization,
          contextSetupMs,
          durationMs: performance.now() - startedAt,
          attemptCount: attempts.length,
          attempts: [...attempts],
          ...result,
        })
      }
    } finally {
      destroySession(native)
    }
  }
  return rows
}

export interface LockstepMainOptions {
  argv?: string[] | undefined
}

export async function main(options: LockstepMainOptions = {}): Promise<void> {
  const opts = { __proto__: null, ...options }
  const config = parseLockstepExperimentArgs(opts.argv ?? process.argv.slice(2))
  if (config.help) {
    process.stdout.write(`${SCRIPT_META.help}\n`)
    return
  }
  const startedAt = performance.now()
  process.stderr.write('Lockstep evaluation: starting Chrome.\n')
  const bridge = await awaitCancellable(
    startBridge({
      model: 'gemma4',
      allowDownload: false,
      readyTimeoutMs: config.timeoutMs,
    }),
    AbortSignal.timeout(config.timeoutMs),
    late => {
      void late.close().catch(() => undefined)
    },
  )
  try {
    const bridgeSetupMs = performance.now() - startedAt
    process.stderr.write(
      'Lockstep evaluation: Chrome is ready. Creating the identity session.\n',
    )
    const factory = createPageBoundFactory(bridge)
    const identitySession = await awaitCancellable(
      factory.create(),
      AbortSignal.timeout(config.timeoutMs),
      destroySession,
    )
    const identityStartedAt = performance.now()
    process.stderr.write('Lockstep evaluation: reading model identity.\n')
    let identity
    try {
      identity = await withTimeout(
        detectModelName(identitySession),
        config.timeoutMs,
        'Model identity',
      )
    } finally {
      destroySession(identitySession)
    }
    const report = {
      schemaVersion: 1,
      evidence: 'real',
      backend: 'chrome-builtin',
      selectedModel: 'gemma4',
      identityEvidence: 'self-reported',
      identity,
      identityDurationMs: performance.now() - identityStartedAt,
      bridgeSetupMs,
      node: process.version,
      pairs: config.pairs,
      mode: config.mode,
      timeoutMs: config.timeoutMs,
      attemptBoundary: 'SessionLike.prompt',
      rows: [] as Awaited<ReturnType<typeof runLockstepContextPair>>,
    }
    for (let pair = 0; pair < config.pairs; pair += 1) {
      process.stderr.write(
        `Lockstep evaluation: pair ${pair + 1}/${config.pairs}.\n`,
      )
      report.rows.push(
        ...(await runLockstepContextPair(factory, pair, config.timeoutMs, {
          mode: config.mode,
        })),
      )
      if (config.output !== undefined) {
        await writeJson(config.output, report)
      }
      const completed = report.rows.filter(row => row.ok).length
      process.stderr.write(
        `Lockstep evaluation: ${completed}/${report.rows.length} cases passed.\n`,
      )
    }
    if (config.output === undefined) {
      process.stdout.write(stringify(report))
    }
    if (report.rows.some(row => !row.ok)) {
      process.exitCode = 1
    }
  } finally {
    await withTimeout(bridge.close(), config.timeoutMs, 'Chrome bridge close')
  }
}

export const SCRIPT_META = {
  describe:
    'Measure full and sparse lockstep with per-request or preloaded native Chrome context.',
  help: 'Usage: pnpm run perf:lockstep [--pairs 3] [--mode per-request|preloaded|both] [--timeout 120000] [--output file.json]\nEvaluates per-request production context by default. Uses installed Gemma 4 without downloading weights. Timeout is milliseconds per operation. Preloading is an optional experiment. Attempts record every SessionLike.prompt call and response. Model identity is self-reported.',
  json: 'native',
} as const

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
