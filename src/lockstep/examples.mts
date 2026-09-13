import type {
  LockstepAnalysis,
  LockstepInput,
  LockstepProposal,
} from './schema.mts'

export interface LockstepExample {
  input: LockstepInput
  output: LockstepAnalysis
}

export function buildLockstepProposalExample(
  example: LockstepExample,
): LockstepProposal {
  const local = example.input.evidence.find(item => item.id === 'local')!
  const test = example.input.evidence.find(item => item.id === 'test')!
  return {
    verdict: example.output.verdict,
    facts: example.output.facts,
    changes: [
      {
        path: local.path,
        evidenceId: local.id,
        startLine: local.startLine,
        endLine: local.startLine,
        operation: 'replace',
        text: 'export const value = 2',
      },
      {
        path: test.path,
        evidenceId: test.id,
        startLine: test.startLine + 2,
        endLine: test.startLine + 2,
        operation: 'append',
        text: '  expect(value).toBe(2)',
      },
    ],
    questions: example.output.questions,
  }
}

// These small examples teach the contract without presenting synthetic code as upstream source.
export function createLockstepExample(
  materialization: 'full' | 'sparse',
): LockstepExample {
  const path =
    materialization === 'full'
      ? 'crates/parser/lib.rs'
      : 'tools/server/protocol.cpp'
  const local = 'src/parser/value.mts'
  const test = 'test/parser/value.test.mts'
  return {
    input: {
      version: 1,
      row: {
        id: 'example-value',
        kind: 'lang-parity',
        materialization,
        upstream: 'example',
        baseSha: 'a'.repeat(40),
        targetSha: 'b'.repeat(40),
        localAreas: ['src/parser'],
        testAreas: ['test/parser'],
        deviations: [],
        sparseCone: materialization === 'sparse' ? ['tools/server'] : [],
      },
      evidence: [
        {
          id: 'base',
          side: 'upstream',
          path,
          sha: 'a'.repeat(40),
          startLine: 1,
          text: 'return 1;',
        },
        {
          id: 'target',
          side: 'upstream',
          path,
          sha: 'b'.repeat(40),
          startLine: 1,
          text: 'return 2;',
        },
        {
          id: 'local',
          side: 'local',
          path: local,
          sha: 'c'.repeat(40),
          startLine: 1,
          text: 'export const value = 1',
        },
        {
          id: 'test',
          side: 'test',
          path: test,
          sha: 'c'.repeat(40),
          startLine: 1,
          text: "import { expect, test } from 'vitest'\nimport { value } from '../../src/parser/value.mts'\ntest('returns the new value', () => {\n})",
        },
      ],
      truncated: false,
    },
    output: {
      verdict: 'port',
      facts: [
        {
          description: 'The new implementation returns 2.',
          evidenceId: 'target',
          startLine: 1,
          endLine: 1,
        },
      ],
      patches: [
        {
          path: local,
          patch: `--- a/${local}\n+++ b/${local}\n@@ -1 +1 @@\n-export const value = 1\n+export const value = 2\n`,
        },
        {
          path: test,
          patch: `--- a/${test}\n+++ b/${test}\n@@ -3 +3,2 @@\n test('returns the new value', () => {\n+  expect(value).toBe(2)\n`,
        },
      ],
      questions: [],
    },
  }
}
