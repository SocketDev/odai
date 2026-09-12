import { createLockstepExample } from '../../lockstep/examples.mts'
import type { LockstepExample } from '../../lockstep/examples.mts'

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
    evidence.text = evidence.text.replaceAll('1', '16').replaceAll('2', '32')
  }
  example.output.facts[0]!.description = 'The target returns a limit of 32.'
  for (const patch of example.output.patches) {
    patch.patch = patch.patch
      .replaceAll('value = 1', 'value = 16')
      .replaceAll('value = 2', 'value = 32')
      .replaceAll('toBe(2)', 'toBe(32)')
  }
  return example
}
