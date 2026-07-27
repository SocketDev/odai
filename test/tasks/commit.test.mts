import { describe, expect, it } from 'vitest'

import { createMockModel } from '../../src/node.mts'
import { suggestCommitMessage } from '../../src/tasks/commit.mts'

describe('suggestCommitMessage', () => {
  it('returns a conventional commit subject', async () => {
    const model = createMockModel(
      '{"subject":"fix(parse): return empty object for empty input"}',
    )
    const result = await suggestCommitMessage(model, 'diff --git a/x b/x')
    expect(result.ok).toBe(true)
    expect(result.data?.subject).toBe(
      'fix(parse): return empty object for empty input',
    )
  })

  it('normalizes message and title synonyms', async () => {
    const model = createMockModel('{"message":"chore: bump deps"}')
    const result = await suggestCommitMessage(model, 'diff --git a/x b/x')
    expect(result.ok).toBe(true)
    expect(result.data?.subject).toBe('chore: bump deps')
  })

  it('reports failure when the response has no subject', async () => {
    const model = createMockModel('{"body":"long prose"}')
    const result = await suggestCommitMessage(model, 'diff --git a/x b/x')
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})
