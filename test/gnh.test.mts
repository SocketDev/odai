import { describe, expect, it } from 'vitest'

import { createMockModel } from '../src/node.mts'
import { formatReport, runEval } from '../src/gnh/index.mts'

describe('gnh evaluator', () => {
  it('runs all scenarios against a mock model', async () => {
    const model = createMockModel(
      '{"summary":"found duplicate lodash versions","findings":[{"severity":"low","package":"lodash","reason":"duplicate version 4.17.15 alongside lodash-es 4.17.21"}],"suggestions":[{"packages":["chalk"],"recommendedVersion":"5.3.0","reasoning":"align on chalk 5"}],"patch":"--- a/greet.js\\n+++ b/greet.js\\n@@ -1,3 +1,3 @@\\n function greet(name) {\\n-  console.log(\\"Hello \\" + name);\\n+  console.log(`Hello ${name}`);\\n }","explanation":"use template literal","sentences":["There are 2 critical and 5 high findings."],"topConcern":"critical","intent":"fix","command":["fix"],"confidence":0.95,"alternative":"lodash-es","reasoning":"lodash-es is the ESM build","anomalies":["duplicate component: chalk appears as 5.3.0 and 4.1.2"]}',
    )
    const report = await runEval({ model })
    expect(report.total).toBe(7)
    expect(report.passed).toBeGreaterThan(0)
    expect(report.score).toBeGreaterThan(0)
    expect(formatReport(report)).toContain('passed')
  })
})
