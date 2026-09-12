import { expect, it } from 'vitest'

import { checkPackedPackage } from '../../../../scripts/repo/check/package.mts'

it('runs the packed exports with complete declarations and browser globals', async () => {
  expect(await checkPackedPackage()).toEqual({
    browser: true,
    runtime: true,
    types: true,
  })
}, 60_000)
