import { parseLockstepProposal } from '../../lockstep/proposal.mts'
import { createLockstepExample } from '../../lockstep/examples.mts'
import type { LockstepExample } from '../../lockstep/examples.mts'
import type { LockstepProposal } from '../../lockstep/schema.mts'

export function createLockstepEvaluation(
  materialization: 'full' | 'sparse',
): LockstepExample {
  const example = createLockstepExample(materialization)
  const upstreamPath =
    materialization === 'full'
      ? 'crates/decoder/limit.rs'
      : 'tools/server/limit.cpp'
  example.input.row.id = `evaluation-${materialization}-limit`
  example.input.row.upstream = 'example-limits'
  for (const evidence of example.input.evidence) {
    if (evidence.side === 'upstream') {
      evidence.path = upstreamPath
    }
    if (evidence.id === 'base') {
      evidence.text = 'return 5;'
    } else if (evidence.id === 'target') {
      evidence.text = 'return 8;'
    } else if (evidence.id === 'local') {
      evidence.text = 'export const value = 5'
    } else {
      evidence.text = evidence.text.replace('toBe(1)', 'toBe(5)')
    }
  }
  example.output.facts[0]!.description = 'The target returns a limit of 8.'
  example.output = parseLockstepProposal(
    example.input,
    createLockstepEvaluationProposal(example),
  )
  return example
}

export function createLockstepEvaluationProposal(
  example: LockstepExample,
): LockstepProposal {
  const local = example.input.evidence.find(item => item.id === 'local')!
  const test = example.input.evidence.find(item => item.id === 'test')!
  return {
    verdict: 'port',
    facts: example.output.facts,
    changes: [
      {
        path: local.path,
        evidenceId: local.id,
        startLine: local.startLine,
        endLine: local.startLine,
        operation: 'replace',
        text: 'export const value = 8',
      },
      {
        path: test.path,
        evidenceId: test.id,
        startLine: test.startLine + 2,
        endLine: test.startLine + 2,
        operation: 'append',
        text: '  expect(value).toBe(8)',
      },
    ],
    questions: [],
  }
}
