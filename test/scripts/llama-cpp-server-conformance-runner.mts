/**
 * @file Conformance runner: llama.cpp's own server test suite, run against
 *   odai's shim. odai presents the routes `llama-server` presents, so the
 *   upstream suite is the conformance corpus. Thin entry — argv, staging, run,
 *   classify, report; the modules under ./llama-cpp-server/ hold the guts.
 *   Run: `pnpm run conformance:llama-cpp-server`.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

import { runMain } from '../../scripts/fleet/_shared/run-main.mts'
import { loadAllowlist } from './llama-cpp-server/allowlist.mts'
import { classifyRun, exitCodeFor } from './llama-cpp-server/classifier.mts'
import { runSuite } from './llama-cpp-server/executor.mts'
import { resolveSuiteDir, stageSuite } from './llama-cpp-server/harness.mts'
import { formatSummary } from './llama-cpp-server/report.mts'
import type { ScriptMeta } from '../../scripts/fleet/_shared/run-main.mts'

const logger = getDefaultLogger()

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const ALLOWLIST_PATH = path.join(
  REPO_ROOT,
  '.config',
  'repo',
  'llama-cpp-server.allowlist',
)

/**
 * Exit code when the pinned submodule is absent: the suite cannot run, and a
 * run that measured nothing never reports success.
 */
const EXIT_NO_SUITE = 69

const SCRIPT_META: ScriptMeta = {
  describe:
    "runs llama.cpp's server test suite against odai's shim and classifies every result against the allowlist",
  help: 'Usage: node test/scripts/llama-cpp-server-conformance-runner.mts',
}

async function main(): Promise<number> {
  const suiteDir = resolveSuiteDir(REPO_ROOT)
  if (suiteDir === undefined) {
    logger.warn(
      'upstream/llama.cpp is not checked out, so the conformance suite has ' +
        'nothing to run. Fetch the submodule: `node ' +
        'scripts/fleet/git-partial-submodule.mts clone upstream/llama.cpp`.',
    )
    return EXIT_NO_SUITE
  }
  const staged = stageSuite(suiteDir)
  logger.info(`staged the suite in ${staged.scratchDir}`)
  const { cases } = await runSuite({
    // The simulator, always: the run has to be deterministic and offline, and
    // the upstream assertions about a model's own words can never pass over any
    // odai backend anyway.
    backendName: 'simulator',
    log: line => logger.info(line),
    staged,
  })
  const summary = classifyRun(cases, loadAllowlist(ALLOWLIST_PATH))
  logger.log(formatSummary(summary))
  return exitCodeFor(summary)
}

runMain(main, SCRIPT_META)
