import { expect, test, vi } from 'vitest'

import {
  lockfileDuplicateScenario,
  sbomAnomalyScenario,
} from '../../src/bench/scenarios.mts'

vi.mock(import('../../src/lockfile-scan.mts'), async importOriginal => ({
  ...(await importOriginal()),
  findRedundantPackages: () => [],
}))

vi.mock(import('../../src/sbom-scan.mts'), async importOriginal => ({
  ...(await importOriginal()),
  findSbomAnomalies: () => [],
}))

test('lockfile scenario reports a deterministic detector regression', async () => {
  const result = await lockfileDuplicateScenario.run({} as never)
  expect(result.ok).toBe(false)
  expect(result.score).toBe(0)
  expect(result.assertion).toContain('expected a lodash-related finding')
})

test('SBOM scenario reports a deterministic detector regression', async () => {
  const result = await sbomAnomalyScenario.run({} as never)
  expect(result.ok).toBe(false)
  expect(result.score).toBe(0)
  expect(result.assertion).toContain('expected duplicate-version anomaly')
})
