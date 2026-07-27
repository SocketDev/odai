/**
 * @file CLI entry for the bench evaluator. Usage: node
 *   src/bench/run.mts # run the simulator backend through the odai seam node
 *   src/bench/run.mts --mock # run with single-response deterministic mock
 *   node src/bench/run.mts --backend=gemini-nano-headless # score a real
 *   registry backend through the same seam. The simulator mode lets the
 *   evaluator run in Node or node-smol without Chrome.
 */

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { createSimulatorBackend } from '../backends/simulator.mts'
import { createBackend, isBackendName } from '../backends/registry.mts'
import { createOdaiModel } from '../model.mts'
import { createMockModel } from '../node.mts'
import { formatReport, runEval } from './index.mts'
import { createBenchResponseRules } from './simulator.mts'
import type { BackendName } from '../backends/types.mts'

const logger = getDefaultLogger()

export interface RunArgs {
  backend: BackendName | undefined
  mock: boolean
}

export function parseArgs(argv: string[]): RunArgs {
  const backendArg = argv
    .find(arg => arg.startsWith('--backend='))
    ?.slice('--backend='.length)
  if (backendArg !== undefined && !isBackendName(backendArg)) {
    throw new Error(
      `--backend=${backendArg} is not a declared backend; run without ` +
        '--backend for the simulator.',
    )
  }
  return {
    backend: backendArg,
    mock: argv.includes('--mock'),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let model
  if (args.backend !== undefined) {
    model = await createOdaiModel({
      backend: createBackend(args.backend),
      systemPrompt: 'You are a helpful supply-chain assistant.',
      temperature: 0,
      topK: 1,
    })
  } else if (args.mock) {
    model = createMockModel(
      '{"summary":"found duplicate lodash versions","findings":[{"severity":"low","package":"lodash","reason":"duplicate version 4.17.15 alongside lodash-es 4.17.21"}],"suggestions":[{"packages":["chalk"],"recommendedVersion":"5.3.0","reasoning":"align on chalk 5"}],"patch":"--- a/greet.js\\n+++ b/greet.js\\n@@ -1,3 +1,3 @@\\n function greet(name) {\\n-  console.log(\\"Hello \\" + name);\\n+  console.log(`Hello ${name}`);\\n }","explanation":"use template literal","fixed":"import { join } from \'node:path\'\\n\\nexport function resolveConfigPath(root, name) {\\n  if (name === \'\') {\\n    return join(root, \'default.json\')\\n  }\\n  return join(root, name)\\n}","sentences":["There are 2 critical and 5 high findings."],"topConcern":"critical","intent":"fix","command":["fix"],"confidence":0.95,"alternative":"lodash-es","reasoning":"lodash-es is the ESM build","anomalies":["duplicate component: chalk appears as 5.3.0 and 4.1.2"]}',
    )
  } else {
    model = await createOdaiModel({
      backend: createSimulatorBackend({
        fallback: '{"summary":"no matching simulator rule"}',
        rules: createBenchResponseRules(),
      }),
      systemPrompt: 'You are a helpful supply-chain assistant.',
      temperature: 0,
      topK: 1,
    })
  }
  const report = await runEval({ model })
  logger.log(formatReport(report))
  process.exit(report.score >= 0.5 ? 0 : 1)
}

main().catch((error: unknown) => {
  logger.fail(error)
  process.exit(1)
})
