import { expect, it } from 'vitest'

import { createAppleFmBackend } from '../../../../src/backends/apple-fm.browser.mts'

it('reports native Apple sessions as unavailable in the browser', async () => {
  const backend = createAppleFmBackend()
  expect((await backend.availability()).available).toBe(false)
  await expect(backend.languageModel()).rejects.toThrow()
})
