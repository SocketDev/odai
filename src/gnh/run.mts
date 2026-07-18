/**
 * @file CLI entry for the Gemini Nano Hints evaluator. Usage: node
 *   src/gnh/run.mts # run with Node LanguageModel simulator node
 *   src/gnh/run.mts --mock # run with single-response deterministic mock The
 *   simulator mode lets the evaluator run in Node or node-smol without Chrome.
 *   Real evaluation requires a browser page with access to the stable
 *   `LanguageModel` API.
 */

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { createGeminiNanoModel } from '../model.mts'
import { createMockModel } from '../node.mts'
import { installLanguageModelSimulator } from '../simulator.mts'
import { formatReport, runEval } from './index.mts'
import { createGnhResponseRules } from './simulator.mts'

const logger = getDefaultLogger()

export interface RunArgs {
  mock: boolean
}

export function parseArgs(argv: string[]): RunArgs {
  return {
    mock: argv.includes('--mock'),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let model
  if (args.mock) {
    model = createMockModel(
      '{"summary":"found duplicate lodash versions","findings":[{"severity":"low","package":"lodash","reason":"duplicate version 4.17.15 alongside lodash-es 4.17.21"}],"suggestions":[{"packages":["chalk"],"recommendedVersion":"5.3.0","reasoning":"align on chalk 5"}],"patch":"--- a/greet.js\\n+++ b/greet.js\\n@@ -1,3 +1,3 @@\\n function greet(name) {\\n-  console.log(\\"Hello \\" + name);\\n+  console.log(`Hello ${name}`);\\n }","explanation":"use template literal","sentences":["There are 2 critical and 5 high findings."],"topConcern":"critical","intent":"fix","command":["fix"],"confidence":0.95,"alternative":"lodash-es","reasoning":"lodash-es is the ESM build","anomalies":["duplicate component: chalk appears as 5.3.0 and 4.1.2"]}',
    )
  } else {
    installLanguageModelSimulator(globalThis, {
      fallback: '{"summary":"no matching simulator rule"}',
      rules: createGnhResponseRules(),
    })
    model = await createGeminiNanoModel({
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
