import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { test } from 'vitest'
import { tolerantTimeout } from '../../../fleet/_shared/lib/timing.mts'
import { buildGemmaBrowserBundle } from '../../../../scripts/repo/cache/image.mts'

test(
  'the shipped browser bundle imports outside the checkout with only Playwright installed',
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gemma-image-runtime-'),
    )
    try {
      const browser = path.join(directory, 'browser.mts')
      await fs.writeFile(browser, await buildGemmaBrowserBundle())
      const require = createRequire(import.meta.url)
      const packageFile = await fs.realpath(
        require.resolve('playwright-core/package.json'),
      )
      await fs.cp(
        path.dirname(packageFile),
        path.join(directory, 'node_modules/playwright-core'),
        {
          recursive: true,
          dereference: true,
        },
      )
      const result = await spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'const module = await import(process.argv[1]); module.assertGemmaIdentity("I am Gemma 4"); process.stdout.write(typeof module.probeGemmaBrowser);',
          pathToFileURL(browser).href,
        ],
        { cwd: directory, timeout: 30_000 },
      )
      assert.equal(result.stdout, 'function')
    } finally {
      await safeDelete(directory)
    }
  },
  tolerantTimeout(30_000),
)
