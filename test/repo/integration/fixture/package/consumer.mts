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
assert.equal(typeof node.setupChromeBuiltin, 'function')

for (const create of [browser.createConversation, node.createConversation]) {
  const factory = new node.LanguageModelSimulator({
    fallback: 'READY',
    rules: [
      {
        when: text =>
          text.includes('PACKED_CONTEXT') &&
          text.includes('Recall the saved code'),
        response: 'PACKED_CONTEXT',
      },
    ],
  })
  const conversation: browser.Conversation = await create(factory)
  await conversation.prompt('Remember PACKED_CONTEXT')
  assert.equal(
    await conversation.prompt('Recall the saved code'),
    'PACKED_CONTEXT',
  )
  const transcript: browser.Message[] = conversation.messages()
  transcript[0]!.content = 'changed copy'
  assert.equal(conversation.messages()[0]!.content, 'Remember PACKED_CONTEXT')
  const restored = await create(factory, {
    initialPrompts: conversation.messages(),
  })
  conversation.destroy()
  assert.equal(
    (await restored.promptStreaming('Recall the saved code')).raw,
    'PACKED_CONTEXT',
  )
  restored.reset([])
  assert.equal(await restored.prompt('Recall the saved code'), 'READY')
  restored.destroy()
}

const candidates = [
  { id: 'inspect', description: 'Inspect the project dependencies.' },
  { id: 'repair', description: 'Repair dependency issues.' },
]
for (const classify of [browser.classifyIntent, node.classifyIntent]) {
  const classified = await classify(
    node.createMockModel('{"actionId":"inspect"}'),
    { query: 'Inspect this project.', candidates },
    { retries: 0 },
  )
  assert.equal(classified.ok, true)
  assert.equal(classified.data?.actionId, 'inspect')

  const abstained = await classify(
    node.createMockModel('{"actionId":null}'),
    { query: 'Describe the weather.', candidates },
    { retries: 0 },
  )
  assert.equal(abstained.ok, true)
  assert.equal(abstained.data?.actionId, null)

  for (const response of [
    '{"actionId":"unknown"}',
    '{"actionId":"inspect","command":"unexpected"}',
    '{"actionId":42}',
  ]) {
    const invalid = await classify(
      node.createMockModel(response),
      { query: 'Inspect this project.', candidates },
      { retries: 0 },
    )
    assert.equal(invalid.ok, false)
    assert.equal(invalid.data, undefined)
  }
}

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
