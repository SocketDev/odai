import { describe, expect, it } from 'vitest'

import { createMockModel } from '../src/node.mts'
import { formatReport, runEval } from '../src/bench/index.mts'

describe('bench evaluator', () => {
  it('runs all scenarios against a mock model', async () => {
    const model = createMockModel(
      '{"summary":"found duplicate lodash versions","findings":[{"severity":"low","package":"lodash","reason":"duplicate version 4.17.15 alongside lodash-es 4.17.21"}],"suggestions":[{"packages":["chalk"],"recommendedVersion":"5.3.0","reasoning":"align on chalk 5"}],"patch":"--- a/greet.js\\n+++ b/greet.js\\n@@ -1,3 +1,3 @@\\n function greet(name) {\\n-  console.log(\\"Hello \\" + name);\\n+  console.log(`Hello ${name}`);\\n }","explanation":"use template literal","fixed":"import { join } from \'node:path\'\\n\\nexport function resolveConfigPath(root, name) {\\n  if (name === \'\') {\\n    return join(root, \'default.json\')\\n  }\\n  return join(root, name)\\n}","sentences":["There are 2 critical and 5 high findings."],"topConcern":"critical","intent":"fix","command":["fix"],"confidence":0.95,"alternative":"lodash-es","reasoning":"lodash-es is the ESM build","anomalies":["duplicate component: chalk appears as 5.3.0 and 4.1.2"]}',
    )
    const report = await runEval({ model })
    expect(report.total).toBe(8)
    expect(report.passed).toBeGreaterThan(0)
    expect(report.score).toBeGreaterThan(0)
    expect(formatReport(report)).toContain('passed')
  })

  it('records a per-scenario prompt duration and prints it', async () => {
    const model = createMockModel('{"summary":"ok"}')
    const report = await runEval({ model })
    for (const result of report.results) {
      expect(result.durationMs).toBeTypeOf('number')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    }
    expect(formatReport(report)).toMatch(/\(\d+ms\)/)
  })

  it('omits the timing suffix when a result carries no duration', () => {
    const printed = formatReport({
      passed: 1,
      results: [
        {
          assertion: 'ok',
          durationMs: undefined,
          name: 'no-timing',
          ok: true,
          raw: '{}',
        },
      ],
      score: 1,
      total: 1,
    })
    expect(printed).toContain('[PASS] no-timing')
    expect(printed).not.toMatch(/no-timing \(/)
  })

  it('scores an empty scenario battery as zero', async () => {
    const report = await runEval({
      model: createMockModel('{}'),
      scenarios: [],
    })
    expect(report.total).toBe(0)
    expect(report.score).toBe(0)
  })
})
