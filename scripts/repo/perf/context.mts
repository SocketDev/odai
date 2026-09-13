import process from 'node:process'
import { parseArgs } from 'node:util'

import { stringify, writeJson } from '@socketsecurity/lib-stable/fs/write-json'

// This benchmark measures source and payload types from this working tree.
// oxlint-disable-next-line socket/prefer-stable-self-import -- source bench
import { compareContextSessions } from '../../../src/bench/context.mts'
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
  --context-lines <count>   Reference lines, 0–256. Default: 64.
  --timeout <milliseconds>  Per-operation limit, 1–2147483647ms. Default: 120000.
  --output <file.json>      Write JSON to this path. Default: standard output.
  --json                   Emit the default JSON report.
  -h, --help               Show this help.
`

export interface ContextArguments extends ContextInput {
  help: boolean
  output?: string | undefined
}

export function parseContextArgs(argv: string[]): ContextArguments {
  const { values } = parseArgs({
    args: argv,
    options: {
      pairs: { type: 'string', default: '3' },
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
  return {
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

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseContextArgs(argv)
  if (options.help) {
    process.stdout.write(CONTEXT_HELP)
    return
  }
  const { startBridge } =
    await import('../../../src/backends/chrome-builtin.mts')
  const startedAt = performance.now()
  const bridge = await startBridge({
    model: 'gemma4',
    allowDownload: false,
    readyTimeoutMs: options.timeoutMs,
  })
  const bridgeSetupMs = performance.now() - startedAt
  try {
    const { pairs, contextLines, timeoutMs } = options
    const result = await bridge.page.evaluate<ContextReport>(
      compareContextSessions,
      { pairs, contextLines, timeoutMs },
    )
    const report = {
      schemaVersion: 1,
      evidence: 'real',
      requestedModel: 'gemma4',
      node: process.version,
      bridgeSetupMs,
      pairs,
      contextLines,
      timeoutMs,
      ...result,
    }
    if (options.output === undefined) {
      process.stdout.write(stringify(report))
    } else {
      await writeJson(options.output, report)
    }
    if (result.samples.some(sample => !sample.ok)) {
      process.exitCode = 1
    }
  } finally {
    await bridge.close()
  }
}

if (isMainModule(import.meta.url)) {
  runMain(main, {
    describe: 'compares retained and replayed Chrome conversation context',
    help: CONTEXT_HELP,
    json: 'native',
  })
}
