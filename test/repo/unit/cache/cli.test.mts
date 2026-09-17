import process from 'node:process'
import { afterEach, expect, test } from 'vitest'
import { getCacheArgs } from '../../../../scripts/repo/cache/cli.mts'

const originalArgv = process.argv

afterEach(() => {
  process.argv = originalArgv
})

test('removes only the shared JSON option', () => {
  process.argv = ['node', 'cache.mts', 'kernel', '--json', '--since', '0']
  expect(getCacheArgs()).toEqual(['kernel', '--since', '0'])
})
