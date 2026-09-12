import { expect, it, vi } from 'vitest'
import { loadShimModule, probeAppleFm } from '../../src/backends/apple-fm.mts'

vi.mock(import('../../src/backends/apple-fm-shim.mts'), () => {
  throw new Error('Node-only shim absent from fixture bundle')
})

it('reports a missing Node shim as unavailable and rejects direct loading', async () => {
  expect((await probeAppleFm({ env: {} })).available).toBe(false)
  await expect(loadShimModule()).rejects.toThrow()
})
