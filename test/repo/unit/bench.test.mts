import path from 'node:path'

import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { expect, test } from 'vitest'

import packageJson from '../../../package.json' with { type: 'json' }

test('describes the benchmark without loading a backend', async () => {
  const result = await spawn(
    process.execPath,
    [
      path.join(process.cwd(), 'scripts/repo/bench.mts'),
      '--describe',
      '--json',
    ],
    { stdioString: true, throws: false },
  )
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    name: 'bench.mts',
    version: packageJson.version,
  })
})
