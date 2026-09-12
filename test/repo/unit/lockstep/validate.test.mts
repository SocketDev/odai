import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { createLockstepExample } from '../../../../src/lockstep/examples.mts'
import { isLockstepPatch } from '../../../../src/lockstep/patch.mts'
import {
  parseLockstepInput,
  validateLockstepAnalysis,
} from '../../../../src/lockstep/validate.mts'

describe('lockstep work items', () => {
  it.each(['full', 'sparse'] as const)(
    'accepts %s materialization without sharing mutable input',
    materialization => {
      const { input } = createLockstepExample(materialization)
      const parsed = parseLockstepInput(input)
      parsed.row.localAreas.push('src/other')
      expect(input.row.localAreas).toEqual(['src/parser'])
    },
  )

  it('rejects coercion and unknown properties', () => {
    const { input } = createLockstepExample('full')
    expect(() => parseLockstepInput({ ...input, version: '1' })).toThrow(
      'invalid-input',
    )
    expect(() =>
      parseLockstepInput({ ...input, command: 'git reset' }),
    ).toThrow('invalid-input')
    expect(() =>
      parseLockstepInput({ ...input, row: { ...input.row, apply: true } }),
    ).toThrow('invalid-input')
  })

  it.each([
    '../src',
    '/src',
    'src/../core',
    'src//core',
    'src\\core',
    'src/%2e%2e',
    'src\0core',
    './src',
  ])('rejects ambiguous area %s', area => {
    const { input } = createLockstepExample('full')
    input.row.localAreas = [area]
    expect(() => parseLockstepInput(input)).toThrow('invalid-area')
  })

  it('rejects overlapping and protected write areas', () => {
    const { input } = createLockstepExample('full')
    input.row.testAreas = ['src/parser/test']
    expect(() => parseLockstepInput(input)).toThrow('overlapping-areas')
    input.row.localAreas = ['upstream/example']
    expect(() => parseLockstepInput(input)).toThrow('protected-area')
  })

  it('rejects evidence with duplicate identities or a different upstream commit', () => {
    const { input } = createLockstepExample('full')
    input.evidence.push(input.evidence[0]!)
    expect(() => parseLockstepInput(input)).toThrow('invalid-evidence')
    input.evidence.pop()
    input.evidence[0]!.sha = 'd'.repeat(40)
    expect(() => parseLockstepInput(input)).toThrow('unanchored-evidence')
  })

  it('enforces sparse boundaries and materialization consistency', () => {
    const { input } = createLockstepExample('sparse')
    input.evidence[0]!.path = 'tools/client/main.cpp'
    expect(() => parseLockstepInput(input)).toThrow('outside-sparse-cone')
    input.row.sparseCone = []
    expect(() => parseLockstepInput(input)).toThrow('invalid-materialization')
  })

  it('rejects local evidence outside its declared area', () => {
    const { input } = createLockstepExample('full')
    input.evidence[2]!.path = 'src/other/value.mts'
    expect(() => parseLockstepInput(input)).toThrow('outside-evidence-area')
  })

  it('bounds both individual excerpts and aggregate evidence', () => {
    const { input } = createLockstepExample('full')
    input.evidence[0]!.text = 'a'.repeat(12_001)
    expect(() => parseLockstepInput(input)).toThrow('invalid-input')
    input.evidence = Array.from({ length: 12 }, (_, index) => ({
      ...input.evidence[0]!,
      id: `e${index}`,
      text: 'a'.repeat(12_000),
    }))
    expect(() => parseLockstepInput(input)).toThrow('evidence-budget')
  })
})

describe('lockstep analysis', () => {
  it('rejects forged authority when JavaScript callers skip input parsing', () => {
    const { input, output } = createLockstepExample('full')
    input.row.localAreas = ['upstream/example']
    expect(validateLockstepAnalysis(input, output).questions).toEqual([
      'lockstep:invalid-input',
    ])
    expect(
      validateLockstepAnalysis(undefined as unknown as typeof input, output)
        .questions,
    ).toEqual(['lockstep:invalid-input'])
  })

  it('absorbs arbitrary JSON responses without expanding patch authority', () => {
    const { input } = createLockstepExample('full')
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        const result = validateLockstepAnalysis(input, value)
        expect(result.verdict).toBe('abstain')
        expect(result.patches).toEqual([])
      }),
      { numRuns: 128, seed: 7319 },
    )
  })

  it('rejects citations after the evidence for arbitrary positive offsets', () => {
    const { input, output } = createLockstepExample('full')
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10_000_000 }), line => {
        output.facts[0]!.endLine = line
        expect(validateLockstepAnalysis(input, output).verdict).toBe('abstain')
      }),
      { numRuns: 64, seed: 7320 },
    )
  })

  it.each(['full', 'sparse'] as const)(
    'accepts bounded %s proposals with cited facts and regression tests',
    materialization => {
      const { input, output } = createLockstepExample(materialization)
      expect(validateLockstepAnalysis(input, output)).toEqual(output)
    },
  )

  it('abstains on unknown fields and wrong primitive types', () => {
    const { input, output } = createLockstepExample('full')
    expect(
      validateLockstepAnalysis(input, { ...output, trusted: true }).verdict,
    ).toBe('abstain')
    output.facts[0]!.endLine = '1' as unknown as number
    expect(validateLockstepAnalysis(input, output).questions).toEqual([
      'lockstep:invalid-analysis',
    ])
  })

  it.each(['missing', 'local', 'test'])(
    'rejects citation identity %s',
    evidenceId => {
      const { input, output } = createLockstepExample('full')
      output.facts[0]!.evidenceId = evidenceId
      expect(validateLockstepAnalysis(input, output).questions).toEqual([
        'lockstep:invalid-citation',
      ])
    },
  )

  it('checks excerpt offsets without counting a final newline as evidence', () => {
    const { input, output } = createLockstepExample('full')
    input.evidence[1]!.startLine = 10
    input.evidence[1]!.text = 'return 2;\n'
    output.facts[0]!.startLine = 10
    output.facts[0]!.endLine = 10
    expect(validateLockstepAnalysis(input, output).verdict).toBe('port')
    output.facts[0]!.endLine = 11
    expect(validateLockstepAnalysis(input, output).verdict).toBe('abstain')
  })

  it.each([
    '.gitmodules',
    'src/parser/package.json',
    'src/parser/value.snap',
    'src/parser/generated/value.mts',
    'src/parser/allowlist.mts',
    'src/parser/config.mts',
    'src/parser/expected-failures.mts',
    'src/parser/../outside.mts',
  ])('rejects protected patch %s', path => {
    const { input, output } = createLockstepExample('full')
    output.patches[0] = {
      path,
      patch: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+bad\n`,
    }
    expect(validateLockstepAnalysis(input, output).questions).toEqual([
      'lockstep:invalid-patch',
    ])
  })

  it('requires both an implementation patch and a regression test', () => {
    const { input, output } = createLockstepExample('full')
    output.patches.pop()
    expect(validateLockstepAnalysis(input, output).questions).toEqual([
      'lockstep:missing-regression-test',
    ])
  })

  it('requires cited facts and rejects duplicate patches', () => {
    const { input, output } = createLockstepExample('full')
    output.patches.push(output.patches[0]!)
    expect(validateLockstepAnalysis(input, output).questions).toEqual([
      'lockstep:invalid-patch',
    ])
    output.patches.pop()
    output.facts = []
    expect(validateLockstepAnalysis(input, output).questions).toEqual([
      'lockstep:missing-facts',
    ])
  })

  it('accepts no-change with evidence but never with a patch', () => {
    const { input, output } = createLockstepExample('full')
    output.verdict = 'no-change'
    expect(validateLockstepAnalysis(input, output).questions).toEqual([
      'lockstep:unexpected-patch',
    ])
    output.patches = []
    expect(validateLockstepAnalysis(input, output).verdict).toBe('no-change')
  })

  it('abstains on truncation and requires an abstention reason', () => {
    const { input, output } = createLockstepExample('full')
    input.truncated = true
    expect(validateLockstepAnalysis(input, output).questions).toEqual([
      'lockstep:incomplete-evidence',
    ])
    input.truncated = false
    output.verdict = 'abstain'
    output.patches = []
    expect(validateLockstepAnalysis(input, output).questions).toEqual([
      'lockstep:missing-reason',
    ])
  })
})

describe('ordinary single-file patches', () => {
  it.each([
    '--- a/x\n+++ b/x\n@@ -1 +1 @@\n unchanged\n',
    '--- a/x\n+++ b/x\n@@ -0,0 +0,0 @@\n',
    'diff --git a/x b/x\nold mode 100644\nnew mode 100755\n',
    '--- a/other\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
    '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+c\n',
    '--- a/x\n+++ b/x\n@@ -1,2 +1 @@\n-a\n+b\n',
    '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n--- a/y\n+++ b/y\n',
    '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b',
  ])('rejects a malformed or expanded patch', patch => {
    expect(isLockstepPatch('x', patch)).toBe(false)
  })

  it('accepts additions and adjacent counted hunks', () => {
    expect(
      isLockstepPatch('x', '--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+new\n'),
    ).toBe(true)
    expect(
      isLockstepPatch(
        'x',
        '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -3 +3 @@\n-c\n+d\n',
      ),
    ).toBe(true)
  })
})
