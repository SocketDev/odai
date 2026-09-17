import path from 'node:path'

import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { expect, test } from 'vitest'

test('describes the build without running it', async () => {
  const result = await spawn(
    process.execPath,
    [
      path.join(process.cwd(), 'scripts/repo/build.mts'),
      '--describe',
      '--json',
    ],
    { stdioString: true, throws: false },
  )
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    name: 'build.mts',
    version: '0.2.2-prerelease',
  })
})
