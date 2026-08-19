/**
 * @file Gate wrapper for the llama.cpp server conformance runner. Spawns the
 *   runner and asserts it exits 0, so an unexpected upstream failure or a stale
 *   allowlist entry fails a test run rather than waiting for someone to
 *   remember the script. Opt-in: the run needs `uv` plus the pinned python
 *   packages from PyPI, and the default suite stays offline, so it skips unless
 *   ODAI_CONFORMANCE=1 and the pinned submodule is checked out.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { spawn } from '@socketsecurity/lib/process/spawn/child'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const RUNNER = path.join(
  REPO_ROOT,
  'test',
  'scripts',
  'llama-cpp-server-conformance-runner.mts',
)

const SUITE_MARKER = path.join(
  REPO_ROOT,
  'upstream',
  'llama.cpp',
  'tools',
  'server',
  'tests',
  'utils.py',
)

const TIMEOUT_MS = 10 * 60 * 1000

const skipTests =
  process.env['ODAI_CONFORMANCE'] !== '1' || !existsSync(SUITE_MARKER)

describe.skipIf(skipTests)('llama.cpp server conformance', () => {
  it(
    'no unexpected failures vs the allowlist',
    async () => {
      const result = await spawn('node', [RUNNER], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      })
      expect(result.code).toBe(0)
    },
    TIMEOUT_MS,
  )
})
