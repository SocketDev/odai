import { describe, expect, it } from 'vitest'

import { createMockModel } from '../../src/node.mts'
import { dedupeDependencies } from '../../src/tasks/dedupe.mts'

describe('dedupeDependencies', () => {
  it('returns deduplication suggestions', async () => {
    const model = createMockModel(
      '{"suggestions":[{"packages":["chalk"],"recommendedVersion":"5.3.0","reasoning":"align"}]}',
    )
    const result = await dedupeDependencies(model, '{}', '{}')
    expect(result.ok).toBe(true)
    expect(result.data?.suggestions).toHaveLength(1)
    expect(result.data?.suggestions[0]?.recommendedVersion).toBe('5.3.0')
  })

  it('normalizes synonymous keys', async () => {
    const model = createMockModel(
      '{"recommendations":[{"packageNames":["chalk"],"targetVersion":"5.3.0","reason":"align"}]}',
    )
    const result = await dedupeDependencies(model, '{}', '{}')
    expect(result.ok).toBe(true)
    expect(result.data?.suggestions[0]?.packages).toEqual(['chalk'])
  })
})
