import { describe, expect, it } from 'vitest'

import { createLockstepExample } from '../../../../src/lockstep/examples.mts'
import { parseLockstepProposal } from '../../../../src/lockstep/proposal.mts'

function createProposal() {
  const { input, output } = createLockstepExample('full')
  const local = input.evidence.find(item => item.id === 'local')!
  const test = input.evidence.find(item => item.id === 'test')!
  return {
    input,
    output,
    proposal: {
      verdict: 'port' as const,
      facts: output.facts,
      changes: [
        {
          path: local.path,
          evidenceId: local.id,
          startLine: local.startLine,
          endLine: local.startLine,
          operation: 'replace' as const,
          text: 'export const value = 2',
        },
        {
          path: test.path,
          evidenceId: test.id,
          startLine: test.startLine + 2,
          endLine: test.startLine + 2,
          operation: 'append' as const,
          text: '  expect(value).toBe(2)',
        },
      ],
      questions: [],
    },
  }
}

describe('lockstep replacement proposals', () => {
  it('turns exact source replacements and additive tests into verified patches', () => {
    const { input, output, proposal } = createProposal()
    expect(parseLockstepProposal(input, proposal)).toEqual(output)
  })

  it('rejects line ranges outside supplied evidence', () => {
    const { input, proposal } = createProposal()
    proposal.changes[0]!.startLine = 2
    expect(() => parseLockstepProposal(input, proposal)).toThrow(
      'lockstep:invalid-change',
    )
    proposal.changes[0]!.startLine = 1
    proposal.changes[0]!.evidenceId = 'target'
    expect(() => parseLockstepProposal(input, proposal)).toThrow(
      'lockstep:invalid-change',
    )
  })
})
