import assert from 'node:assert/strict'
import * as browser from '@socketsecurity/odai'
import * as bench from '@socketsecurity/odai/bench'
import * as node from '@socketsecurity/odai/node'

const model: browser.OdaiModel = node.createMockModel(
  '{"summary":"ready","keyPoints":[]}',
)
const result = await browser.summarizeText(model, 'A consumer example.')
assert.equal(result.ok, true)
assert.equal(result.data?.summary, 'ready')
const report: bench.EvalReport = await bench.runEval({
  model,
  scenarios: [
    {
      name: 'packed summary',
      async run(candidate) {
        const answer = await node.summarizeText(
          candidate,
          'A consumer example.',
        )
        return {
          assertion: 'the packed helper returns its summary',
          name: 'packed summary',
          score: answer.ok ? 1 : 0,
          ok: answer.ok,
          raw: answer.raw,
        }
      },
    },
  ],
})
assert.equal(report.score, 1)
assert.equal(bench.allScenarios.length > 0, true)
assert.equal(typeof browser.createBuiltinModel, 'function')
assert.equal(typeof node.runCli, 'function')

const lockstep: node.LockstepInput = node.parseLockstepInput({
  version: 1,
  row: {
    id: 'packed-node',
    kind: 'feature-parity',
    materialization: 'sparse',
    upstream: 'example',
    baseSha: 'a'.repeat(40),
    targetSha: 'b'.repeat(40),
    localAreas: ['src/parser'],
    testAreas: ['test/parser'],
    deviations: [],
    sparseCone: ['crates/parser'],
  },
  evidence: [],
  truncated: false,
})
const analysis = await node.analyzeLockstep(model, lockstep)
assert.equal(analysis.ok, true)
assert.equal(
  browser.validateLockstepAnalysis(lockstep, analysis.data).verdict,
  'abstain',
)
