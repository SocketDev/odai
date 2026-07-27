import { describe, expect, it } from 'vitest'

import { createMockModel } from '../../src/node.mts'
import { summarizeText } from '../../src/tasks/summarize.mts'

describe('summarizeText', () => {
  it('returns a summary with key points', async () => {
    const model = createMockModel(
      '{"summary":"the deploy failed once and recovered","points":["migration timed out","retry succeeded"]}',
    )
    const result = await summarizeText(model, 'deploy log text')
    expect(result.ok).toBe(true)
    expect(result.data?.summary).toContain('deploy failed')
    expect(result.data?.points).toHaveLength(2)
  })

  it('normalizes overview and bullets synonyms', async () => {
    const model = createMockModel(
      '{"overview":"short recap","bullets":["one","two"]}',
    )
    const result = await summarizeText(model, 'anything')
    expect(result.ok).toBe(true)
    expect(result.data?.summary).toBe('short recap')
    expect(result.data?.points).toEqual(['one', 'two'])
  })

  it('reports failure when the response has no summary', async () => {
    const model = createMockModel('{"points":["one"]}')
    const result = await summarizeText(model, 'anything')
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})
