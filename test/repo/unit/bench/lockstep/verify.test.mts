import { describe, expect, it } from 'vitest'
import {
  createLockstepEvaluation,
  createLockstepEvaluationProposal,
} from '../../../../../src/bench/lockstep/fixtures.mts'
import { verifyLockstepEvaluation } from '../../../../../src/bench/lockstep/verify.mts'
import { parseLockstepProposal } from '../../../../../src/lockstep/proposal.mts'

describe.each(['full', 'sparse'] as const)('%s fixture behavior', mode => {
  it('accepts equivalent formatting, aliased imports, and reversed patch order', () => {
    const example = createLockstepEvaluation(mode)
    const proposal = createLockstepEvaluationProposal(example)
    proposal.changes[0]!.text = 'export const value=8;'
    proposal.changes[1]!.operation = 'replace'
    proposal.changes[1]!.startLine = 1
    proposal.changes[1]!.endLine = 4
    proposal.changes[1]!.text =
      "import {test as check, expect as assert} from 'vitest';\nimport {value as limit} from '../../src/parser/value.mts';\ncheck('updated limit', function () { assert(limit).toBe(8); });"
    const analysis = parseLockstepProposal(example.input, proposal)
    analysis.patches.reverse()
    expect(verifyLockstepEvaluation(example.input, analysis)).toBe(true)
  })

  it.each([
    ['export const value = 5', 'expect(value).toBe(8)'],
    ['export const value =', 'expect(value).toBe(8)'],
    ['const value = 8', 'expect(value).toBe(8)'],
    ['export let value = 8', 'expect(value).toBe(8)'],
    ['export const value = 8', 'expect(value).toEqual(8)'],
    ['export const value = 8', 'expect(8).toBe(8)'],
    ['export const value = 8', 'expect(value).toBe(5)'],
    ['export const value = 8', 'if (false) { expect(value).toBe(8) }'],
    ['export const value = 8', 'const value = 8; expect(value).toBe(8)'],
    ['export const value = 8', 'console.log(value)'],
  ])(
    'rejects wrong behavior or ineffective assertions',
    (source, assertion) => {
      const example = createLockstepEvaluation(mode)
      const proposal = createLockstepEvaluationProposal(example)
      proposal.changes[0]!.text = source
      proposal.changes[1]!.text = assertion
      let valid = false
      try {
        valid = verifyLockstepEvaluation(
          example.input,
          parseLockstepProposal(example.input, proposal),
        )
      } catch {
        valid = false
      }
      expect(valid).toBe(false)
    },
  )

  it.each([
    "import { expect, test } from 'vitest'; import { value } from '../../src/parser/other.mts'; test('limit', () => { expect(value).toBe(8) })",
    "import { expect, test } from 'example-test'; import { value } from '../../src/parser/value.mts'; test('limit', () => { expect(value).toBe(8) })",
    "import { expect, test } from 'vitest'; import { value } from '../../src/parser/value.mts'; test = () => {}; test('limit', () => { expect(value).toBe(8) })",
    "import { expect, test } from 'vitest'; import { value } from '../../src/parser/value.mts'; test('limit', value => { expect(value).toBe(8) })",
    "import { expect, test } from 'vitest'; import { value } from '../../src/parser/value.mts'; test('limit', function* () { expect(value).toBe(8) })",
    "import { expect, test } from 'vitest'; import { value } from '../../src/parser/value.mts'; test.skip('limit', () => { expect(value).toBe(8) })",
    "import { expect, test } from 'vitest'; import { value } from '../../src/parser/value.mts'; function hidden() { test('limit', () => { expect(value).toBe(8) }) }",
  ])(
    'rejects disconnected imports, disabled tests, and shadowed runners',
    code => {
      const example = createLockstepEvaluation(mode)
      const proposal = createLockstepEvaluationProposal(example)
      proposal.changes[1]!.operation = 'replace'
      proposal.changes[1]!.startLine = 1
      proposal.changes[1]!.endLine = 4
      proposal.changes[1]!.text = code
      expect(
        verifyLockstepEvaluation(
          example.input,
          parseLockstepProposal(example.input, proposal),
        ),
      ).toBe(false)
    },
  )

  it('rejects mismatched, duplicate, and out-of-scope patch paths', () => {
    const example = createLockstepEvaluation(mode)
    for (const path of [
      'src/other/value.mts',
      'src/parser/other.mts',
      example.output.patches[1]!.path,
    ]) {
      const analysis = createLockstepEvaluation(mode).output
      analysis.patches[0]!.path = path
      expect(verifyLockstepEvaluation(example.input, analysis)).toBe(false)
    }
  })
})

it('rejects partial implementation evidence instead of assuming a complete fixture', () => {
  const example = createLockstepEvaluation('full')
  const local = example.input.evidence.find(item => item.side === 'local')!
  local.startLine = 2
  expect(verifyLockstepEvaluation(example.input, example.output)).toBe(false)
})
