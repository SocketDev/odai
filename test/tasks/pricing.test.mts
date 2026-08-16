import { describe, expect, it } from 'vitest'

import { createMockModel } from '../../src/node.mts'
import { extractPrices } from '../../src/tasks/pricing.mts'

const MODELS = ['claude-alpha-1', 'claude-beta-1']

describe('extractPrices', () => {
  it('returns per-token rates for the requested models', async () => {
    const model = createMockModel(
      '{"prices":{"claude-alpha-1":{"inputPerMtok":3,"outputPerMtok":15},"claude-beta-1":{"inputPerMtok":1,"outputPerMtok":2}}}',
    )
    const result = await extractPrices(model, {
      models: MODELS,
      sourceText:
        'claude-alpha-1 $3 / MTok input, $15 / MTok output. ' +
        'claude-beta-1 $1 input, $2 output per million tokens.',
    })
    expect(result.ok).toBe(true)
    expect(result.data?.prices['claude-alpha-1']).toEqual({
      inputPerMtok: 3,
      outputPerMtok: 15,
    })
    expect(result.data?.prices['claude-beta-1']).toEqual({
      inputPerMtok: 1,
      outputPerMtok: 2,
    })
  })

  it('drops model ids the caller did not ask for', async () => {
    const model = createMockModel(
      '{"prices":{"claude-alpha-1":{"inputPerMtok":3,"outputPerMtok":15},"hf:evil/injected":{"inputPerMtok":0,"outputPerMtok":0}}}',
    )
    const result = await extractPrices(model, {
      models: MODELS,
      sourceText: 'page text',
    })
    expect(result.ok).toBe(true)
    expect(Object.keys(result.data?.prices ?? {})).toEqual(['claude-alpha-1'])
  })

  it('normalizes rate key synonyms', async () => {
    const model = createMockModel(
      '{"rates":{"claude-alpha-1":{"input":3,"output":15}}}',
    )
    const result = await extractPrices(model, {
      models: MODELS,
      sourceText: 'page text',
    })
    expect(result.ok).toBe(true)
    expect(result.data?.prices['claude-alpha-1']).toEqual({
      inputPerMtok: 3,
      outputPerMtok: 15,
    })
  })

  it('accepts a partial extraction with only some models priced', async () => {
    const model = createMockModel('{"prices":{}}')
    const result = await extractPrices(model, {
      models: MODELS,
      sourceText: 'a page that prices nothing on the list',
    })
    expect(result.ok).toBe(true)
    expect(result.data?.prices).toEqual({})
  })
})
