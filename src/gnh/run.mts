/**
 * @file CLI entry for the Gemini Nano Hints evaluator. Usage: node
 *   src/gnh/run.mts --mock In mock mode the evaluator runs against a
 *   deterministic mock model so it can be exercised in CI or without Chrome.
 *   Real evaluation requires a browser build/page that wires the evaluator to
 *   `window.LanguageModel`.
 */

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { createMockModel } from '../node.mts'
import { formatReport, runEval } from './index.mts'

const logger = getDefaultLogger()

export function parseArgs(argv: string[]): { mock: boolean } {
  return {
    mock: argv.includes('--mock'),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.mock) {
    logger.fail('Usage: node src/gnh/run.mts --mock')
    logger.fail(
      'Real evaluation runs in a browser page with access to the stable LanguageModel API.',
    )
    process.exit(1)
  }

  const model = createMockModel(
    '{"summary":"found duplicate lodash versions","findings":[{"severity":"low","package":"lodash","reason":"duplicate version 4.17.15 alongside lodash-es 4.17.21"}],"suggestions":[{"packages":["chalk"],"recommendedVersion":"5.3.0","reasoning":"align on chalk 5"}],"patch":"--- a/greet.js\\n+++ b/greet.js\\n@@ -1,3 +1,3 @@\\n function greet(name) {\\n-  console.log(\\"Hello \\" + name);\\n+  console.log(`Hello ${name}`);\\n }","explanation":"use template literal","sentences":["There are 2 critical and 5 high findings."],"topConcern":"critical","intent":"fix","command":["fix"],"confidence":0.95,"alternative":"lodash-es","reasoning":"lodash-es is the ESM build","anomalies":["duplicate component: chalk appears as 5.3.0 and 4.1.2"]}',
  )
  const report = await runEval({ model })
  logger.log(formatReport(report))
  process.exit(report.score >= 0.5 ? 0 : 1)
}

main().catch((error: unknown) => {
  logger.fail(error)
  process.exit(1)
})
