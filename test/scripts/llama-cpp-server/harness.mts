/**
 * @file Suite staging for the llama.cpp server conformance runner. The pinned
 *   `upstream/llama.cpp` tree is never run in place: the files the run needs
 *   are COPIED into an `os.tmpdir()` scratch directory, so pytest's caches,
 *   its `__pycache__` output, and the model cache land outside the submodule.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The upstream files one run needs: the harness module, the session fixtures,
 * pytest's config, and the test files that exercise routes odai serves. Every
 * other upstream test file targets a route odai does not implement, so copying
 * it would only grow the allowlist.
 */
export const SUITE_FILES: readonly string[] = [
  'conftest.py',
  'pytest.ini',
  'utils.py',
  'unit/test_chat_completion.py',
  'unit/test_compat_anthropic.py',
]

/**
 * The test files pytest is pointed at, in the order it runs them.
 */
export const TEST_FILES: readonly string[] = SUITE_FILES.filter(file =>
  file.startsWith('unit/'),
)

export interface StagedSuite {
  /**
   * Where pytest writes its JUnit XML.
   */
  reportPath: string
  /**
   * The scratch directory pytest runs in.
   */
  scratchDir: string
  testFiles: readonly string[]
}

/**
 * Resolve the upstream server-test directory inside the pinned submodule.
 * Returns undefined when the submodule is not checked out, which is the
 * runner's skip condition rather than an error.
 */
export function resolveSuiteDir(repoRoot: string): string | undefined {
  const dir = path.join(
    repoRoot,
    'upstream',
    'llama.cpp',
    'tools',
    'server',
    'tests',
  )
  return existsSync(path.join(dir, 'utils.py')) ? dir : undefined
}

/**
 * Copy the suite into a fresh scratch directory and report where it landed.
 */
export function stageSuite(suiteDir: string): StagedSuite {
  const scratchDir = mkdtempSync(
    path.join(os.tmpdir(), 'odai-llama-conformance-'),
  )
  for (let i = 0, { length } = SUITE_FILES; i < length; i += 1) {
    const relative = SUITE_FILES[i]!
    const target = path.join(scratchDir, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(path.join(suiteDir, relative), target)
  }
  return {
    reportPath: path.join(scratchDir, 'results.xml'),
    scratchDir,
    testFiles: TEST_FILES,
  }
}
