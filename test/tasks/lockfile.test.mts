import { describe, expect, it } from 'vitest'

import { createMockModel } from '../../src/node.mts'
import { reasonAboutLockfile } from '../../src/tasks/lockfile.mts'

describe('reasonAboutLockfile', () => {
  it('returns parsed lockfile reasoning', async () => {
    const model = createMockModel(
      '{"summary":"one duplicate","findings":[{"severity":"low","package":"lodash","reason":"dup"}]}',
    )
    const result = await reasonAboutLockfile(model, '{}')
    expect(result.ok).toBe(true)
    expect(result.data?.summary).toBe('one duplicate')
    expect(result.data?.findings).toHaveLength(1)
  })

  it('normalizes synonymous keys', async () => {
    const model = createMockModel(
      '{"overview":"synonym test","issues":[{"level":"low","name":"lodash","rationale":"dup"}]}',
    )
    const result = await reasonAboutLockfile(model, '{}')
    expect(result.ok).toBe(true)
    expect(result.data?.summary).toBe('synonym test')
    expect(result.data?.findings[0]?.package).toBe('lodash')
  })
})
