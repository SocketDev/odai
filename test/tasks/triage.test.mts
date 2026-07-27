import { describe, expect, it } from 'vitest'

import { createMockModel } from '../../src/node.mts'
import { triageAlerts } from '../../src/tasks/triage.mts'

describe('triageAlerts', () => {
  it('returns sentences and the top concern', async () => {
    const model = createMockModel(
      '{"sentences":["There are 2 critical and 5 high findings."],"topConcern":"critical"}',
    )
    const result = await triageAlerts(model, 'Critical: 2\nHigh: 5')
    expect(result.ok).toBe(true)
    expect(result.data?.sentences[0]).toContain('critical')
    expect(result.data?.topConcern).toBe('critical')
  })

  it('normalizes severity synonym for topConcern', async () => {
    const model = createMockModel(
      '{"sentences":["All quiet."],"severity":"low"}',
    )
    const result = await triageAlerts(model, 'Critical: 0\nLow: 1')
    expect(result.ok).toBe(true)
    expect(result.data?.topConcern).toBe('low')
  })

  it('reports failure when sentences are missing', async () => {
    const model = createMockModel('{"topConcern":"high"}')
    const result = await triageAlerts(model, 'High: 3')
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})
