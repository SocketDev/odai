#!/usr/bin/env node
/*
 * @file Fleet check - CLAUDE.md fits the budget its readers actually enforce.
 *
 *   Codex reads a project doc up to `project_doc_max_bytes` and TRUNCATES past
 *   it, mid-file and silently. The fleet recorded that ceiling in
 *   `_shared/client-limits.mts` as CODEX_PROJECT_DOC_MAX_BYTES and then read it
 *   from nowhere: a constant describing a limit with nothing measuring against
 *   it. Meanwhile CLAUDE.md grew to within a few hundred bytes of the cap, so
 *   the first sign of the problem would have been rules going missing from the
 *   end of the file with no error anywhere.
 *
 *   TWO CEILINGS, DIFFERENT JOBS.
 *
 *   The HARD cap is the client's own number. Past it the doc is truncated and
 *   the rules at the bottom stop existing. That is never acceptable and never
 *   waived.
 *
 *   The RATCHET is this file's recorded high-water mark, and it is SHRINK-ONLY.
 *   It exists because the honest starting position is already past the fleet's
 *   own 95% buffer: seeding the ratchet at the measured size makes the check
 *   enforce "never grow" from the moment it lands, rather than landing red and
 *   being switched off. Every trim lowers it and it can never rise. The gap
 *   between the ratchet and the buffered budget is reported on every run so the
 *   debt stays visible instead of becoming the new normal.
 *
 *   Usage: node scripts/fleet/check/claude-md-fits-the-project-doc-budget.mts
 *   [--quiet]
 */

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import {
  buffered,
  CODEX_PROJECT_DOC_MAX_BYTES,
} from '../_shared/client-limits.mts'
import { isMainModule } from '../_shared/is-main-module.mts'
import { runMain } from '../_shared/run-main.mts'
import { REPO_ROOT } from '../paths.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

/**
 * The project docs this repo owns, relative to the repo root.
 *
 * A member carries one at the root. The wheelhouse carries that PLUS the
 * `template/base` original it cascades from, and the cascaded copy is the one
 * every member will hold, so both are measured.
 */
export const PROJECT_DOC_PATHS: readonly string[] = [
  'CLAUDE.md',
  path.join('template', 'base', 'CLAUDE.md'),
]

/**
 * The high-water mark, in bytes. SHRINK-ONLY.
 *
 * Seeded at the size measured when this check landed, which is already past
 * `buffered(CODEX_PROJECT_DOC_MAX_BYTES)`. Lower it whenever a trim lands;
 * never raise it. The stale-entry arm below fails when it drifts too far above
 * the real size, so shrinking is forced rather than optional.
 */
export const CLAUDE_MD_BYTE_CEILING = 31_755

/**
 * How far the ratchet may sit above the measured size before it counts as
 * stale.
 *
 * Some slack, because a one-word edit should not fail the gate and force a
 * constant bump. Small enough that a real trim has to be recorded.
 */
export const RATCHET_SLACK_BYTES = 512

export interface CheckResult {
  readonly message: string
  readonly name: string
  readonly passed: boolean
}

/**
 * The size of a project doc, or undefined when the repo does not carry it.
 */
export function projectDocSize(
  rel: string,
  repoRoot: string = REPO_ROOT,
): number | undefined {
  const abs = path.join(repoRoot, rel)
  return existsSync(abs) ? statSync(abs).size : undefined
}

/**
 * Measure one project doc against the hard cap and the ratchet.
 */
export function checkProjectDoc(
  rel: string,
  repoRoot: string = REPO_ROOT,
): CheckResult | undefined {
  const size = projectDocSize(rel, repoRoot)
  if (size === undefined) {
    return undefined
  }
  const budget = buffered(CODEX_PROJECT_DOC_MAX_BYTES)
  if (size >= CODEX_PROJECT_DOC_MAX_BYTES) {
    return {
      message:
        `${rel} is ${size} bytes, at or past Codex's ${CODEX_PROJECT_DOC_MAX_BYTES}-byte project-doc cap. ` +
        'Saw: a doc Codex truncates mid-file; wanted one it reads whole. ' +
        'Fix: cut rules to their first clause and move the detail into the docs each already links.',
      name: `${rel} is not truncated by its readers`,
      passed: false,
    }
  }
  if (size > CLAUDE_MD_BYTE_CEILING) {
    return {
      message:
        `${rel} grew to ${size} bytes, past the ${CLAUDE_MD_BYTE_CEILING}-byte ratchet. ` +
        `Saw: +${size - CLAUDE_MD_BYTE_CEILING} bytes; wanted the file to shrink, never grow. ` +
        'Fix: land the new rule by trimming an existing one, so the doc stays inside the budget its readers enforce.',
      name: `${rel} did not grow past the ratchet`,
      passed: false,
    }
  }
  if (CLAUDE_MD_BYTE_CEILING - size > RATCHET_SLACK_BYTES) {
    return {
      message:
        `${rel} is down to ${size} bytes but the ratchet still reads ${CLAUDE_MD_BYTE_CEILING}. ` +
        'Saw: a stale high-water mark; wanted it to record the shrink. ' +
        `Fix: set CLAUDE_MD_BYTE_CEILING to ${size} so the gain locks in.`,
      name: `${rel} ratchet records the current size`,
      passed: false,
    }
  }
  const debt = size - budget
  return {
    message:
      debt > 0
        ? `${rel} is ${size} bytes: inside the ${CODEX_PROJECT_DOC_MAX_BYTES}-byte cap, but ${debt} over the fleet's own ${budget}-byte buffer. The ratchet holds it; trim to clear the debt.`
        : `${rel} is ${size} bytes, inside the ${budget}-byte buffered budget with ${budget - size} to spare.`,
    name: `${rel} fits the project-doc budget`,
    passed: true,
  }
}

export function claudeMdFitsTheProjectDocBudget(repoRoot: string = REPO_ROOT): {
  passed: boolean
  results: CheckResult[]
} {
  const results: CheckResult[] = []
  for (let i = 0, { length } = PROJECT_DOC_PATHS; i < length; i += 1) {
    const result = checkProjectDoc(PROJECT_DOC_PATHS[i]!, repoRoot)
    if (result !== undefined) {
      results.push(result)
    }
  }
  if (results.length === 0) {
    return {
      passed: true,
      results: [
        {
          message: 'no CLAUDE.md in this repo, so there is no doc to budget.',
          name: 'project doc is present',
          passed: true,
        },
      ],
    }
  }
  return { passed: results.every(result => result.passed), results }
}

export async function main(): Promise<number> {
  const quiet = process.argv.includes('--quiet')
  const { passed, results } = claudeMdFitsTheProjectDocBudget()
  if (!quiet) {
    for (let i = 0, { length } = results; i < length; i += 1) {
      const result = results[i]!
      logger.info(`  ${result.passed ? '✓' : '✗'} ${result.message}`)
    }
  }
  if (!passed) {
    if (quiet) {
      const failed = results.filter(result => !result.passed).length
      logger.error(
        `claude-md-fits-the-project-doc-budget: ${failed} check(s) failed`,
      )
    }
    return 1
  }
  return 0
}

const SCRIPT_META: ScriptMeta = {
  describe:
    "verifies CLAUDE.md fits the project-doc budget its readers enforce, and that it only ever shrinks",
  help: `Usage: node scripts/fleet/check/claude-md-fits-the-project-doc-budget.mts [--quiet]

  --quiet  print only a failure summary

Codex truncates a project doc past its project_doc_max_bytes, mid-file and
silently, so rules at the end of CLAUDE.md would simply stop existing. This
measures every CLAUDE.md the repo owns against that cap and against a
shrink-only ratchet.

The ratchet is seeded above the fleet's own 95% buffer because that is the
honest starting position. It blocks growth immediately and reports the
remaining debt on every run; lower CLAUDE_MD_BYTE_CEILING whenever a trim
lands, and never raise it.`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
