import process from 'node:process'
import { parseArgs } from 'node:util'

import { stringify, writeJson } from '@socketsecurity/lib-stable/fs/write-json'

// This benchmark measures source and payload types from this working tree.
// oxlint-disable-next-line socket/prefer-stable-self-import -- source bench
import { compareContextSessions } from '../../../src/bench/context.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- source bench
import { compareConversations } from '../../../src/bench/conversation.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- source bridge
import { createPageBoundFactory } from '../../../src/backends/chrome-page.mts'
// oxlint-disable-next-line socket/prefer-stable-self-import -- source types
import type {
  ContextInput,
  ContextReport,
} from '../../../src/bench/context.mts'
import { isMainModule } from '../../fleet/process/is-main-module.mts'
import { runMain } from '../../fleet/process/run-main.mts'

export const CONTEXT_HELP = `Usage: pnpm run perf:context [options]

Compare retained Chrome context with fresh sessions replaying identical history.
Use the existing Gemma 4 model. This command does not download model weights.

  --pairs <count>           Conversation pairs, 1–20. Default: 3.
  --api <odai|native>       Public API or direct Chrome baseline. Default: odai.
  --context-lines <count>   Reference lines, 0–256. Default: 64.
  --timeout <milliseconds>  Per-operation limit, 1–2147483647ms. Default: 120000.
  --output <file.json>      Write JSON to this path. Default: standard output.
  --json                   Emit the default JSON report.
  -h, --help               Show this help.
`

export interface ContextArguments extends ContextInput {
  api: 'native' | 'odai'
  help: boolean
  output?: string | undefined
}

export function parseContextArgs(argv: string[]): ContextArguments {
  const { values } = parseArgs({
    args: argv,
    options: {
      pairs: { type: 'string', default: '3' },
      api: { type: 'string', default: 'odai' },
      'context-lines': { type: 'string', default: '64' },
      timeout: { type: 'string', default: '120000' },
      output: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.output !== undefined && values.output.trim() === '') {
    throw new RangeError('--output requires a nonempty file path.')
  }
  if (values.api !== 'native' && values.api !== 'odai') {
    throw new RangeError('--api requires odai or native.')
  }
  return {
    api: values.api,
    contextLines: parseContextInteger(
      'context-lines',
      values['context-lines'],
      0,
      256,
    ),
    help: values.help === true,
    output: values.output,
    pairs: parseContextInteger('pairs', values.pairs, 1, 20),
    timeoutMs: parseContextInteger('timeout', values.timeout, 1, 2_147_483_647),
  }
}

export function parseContextInteger(
  name: string,
  value: string,
  minimum: number,
  maximum: number,
): number {
  const number = Number(value)
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(number) ||
    number < minimum ||
    number > maximum
  ) {
    throw new RangeError(
      `--${name} received ${JSON.stringify(value)}. Use an integer from ${minimum} to ${maximum}.`,
    )
  }
  return number
}

export interface ContextMainOptions {
  argv?: string[] | undefined
}

export async function main(options: ContextMainOptions = {}): Promise<void> {
  const opts = { __proto__: null, ...options }
  const config = parseContextArgs(opts.argv ?? process.argv.slice(2))
  if (config.help) {
    process.stdout.write(CONTEXT_HELP)
    return
  }
  const { startBridge } =
    await import('../../../src/backends/chrome-builtin.mts')
  const startedAt = performance.now()
  const bridge = await startBridge({
    model: 'gemma4',
    allowDownload: false,
    readyTimeoutMs: config.timeoutMs,
  })
  const bridgeSetupMs = performance.now() - startedAt
  try {
    const { pairs, contextLines, timeoutMs } = config
    const result =
      config.api === 'native'
        ? await bridge.page.evaluate<ContextReport>(compareContextSessions, {
            pairs,
            contextLines,
            timeoutMs,
          })
        : await compareConversations(createPageBoundFactory(bridge), {
            pairs,
            contextLines,
            timeoutMs,
          })
    const report = {
      schemaVersion: 1,
      api: config.api,
      ...(config.api === 'odai'
        ? {
            userAgent: await bridge.page.evaluate<string>(
              () => navigator.userAgent,
            ),
          }
        : {}),
      timingBoundary:
        config.api === 'odai'
          ? 'public-api-call-including-lazy-session-creation'
          : 'native-session-prompt',
      evidence: 'real',
      requestedModel: 'gemma4',
      node: process.version,
      bridgeSetupMs,
      pairs,
      contextLines,
      timeoutMs,
      ...result,
    }
    if (config.output === undefined) {
      process.stdout.write(stringify(report))
    } else {
      await writeJson(config.output, report)
    }
    if (result.samples.some(sample => !sample.ok)) {
      process.exitCode = 1
    }
  } finally {
    await bridge.close()
  }
}

export const SCRIPT_META = {
  describe: 'compares retained and replayed Chrome conversation context',
  help: CONTEXT_HELP,
  json: 'native',
} as const

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
