#!/usr/bin/env node
/*
 * @file Fleet check - no check sits inert.
 *
 *   A check script that nothing runs is worse than no check at all. It reads
 *   as coverage, it passes review, it costs maintenance, and it catches
 *   nothing. The same is true of a limit recorded as a constant that no check
 *   measures against: `CODEX_PROJECT_DOC_MAX_BYTES` sat in
 *   `_shared/client-limits.mts` describing the byte cap Codex truncates a
 *   project doc at, read from nowhere, while CLAUDE.md grew to within 3% of
 *   it. The doctrine says code is law; a law nobody enforces is a comment.
 *
 *   So this is the check that checks the checks. Every `check/*.mts` must be
 *   reachable from a runner - preflight, the release steps, or another check
 *   that composes it. An unreferenced one fails here, naming itself, and the
 *   fix is always the same: wire it or delete it.
 *
 *   EXEMPTIONS ARE NAMED, NOT INFERRED. A check invoked only by a hook, a
 *   workflow, or an operator on demand is legitimate, but it has to say so
 *   here rather than be silently tolerated by a loose heuristic - the loose
 *   heuristic is how the inert ones hid in the first place.
 *
 *   Usage: node scripts/fleet/check/checks-are-wired.mts [--quiet]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { isMainModule } from '../_shared/is-main-module.mts'
import { runMain } from '../_shared/run-main.mts'
import { REPO_ROOT } from '../paths.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

/**
 * Files that reference a check by name when they run it. A check named in any
 * of these is wired.
 */
export const RUNNER_RELATIVE_PATHS: readonly string[] = [
  // A check exposed as a pnpm script is wired: `pnpm run doctor:auth` is a
  // runner the same way preflight is. Missing this read `setup-is-prompt-less`
  // as inert on the first run, which it is not.
  'package.json',
  path.join('scripts', 'fleet', 'preflight.mts'),
  path.join('scripts', 'fleet', 'check.mts'),
  path.join('scripts', 'fleet', '_shared', 'check-steps-release.mts'),
  path.join('scripts', 'fleet', '_shared', 'check-steps-paths.mts'),
  path.join('scripts', 'fleet', '_shared', 'check-steps-hooks.mts'),
]

/**
 * Checks run somewhere this scanner cannot see, each with the reason.
 *
 * Every entry is a claim that something else invokes it. Adding a name here to
 * silence the gate, rather than because a runner really calls it, is the one
 * way to defeat this check - so the reason is required reading at review.
 */
export const OFF_RUNNER_CHECKS: Readonly<Record<string, string>> = {}

/**
 * Where the check scripts live.
 */
export function checkDir(repoRoot: string = REPO_ROOT): string {
  return path.join(repoRoot, 'scripts', 'fleet', 'check')
}

/**
 * Every check script filename in the repo.
 */
export function checkScripts(repoRoot: string = REPO_ROOT): readonly string[] {
  const dir = checkDir(repoRoot)
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir)
    .filter(name => name.endsWith('.mts'))
    .sort()
}

/**
 * The concatenated text of every runner, plus every check (a check that
 * composes another counts as wiring it).
 */
export function runnerText(repoRoot: string = REPO_ROOT): string {
  const parts: string[] = []
  for (let i = 0, { length } = RUNNER_RELATIVE_PATHS; i < length; i += 1) {
    const abs = path.join(repoRoot, RUNNER_RELATIVE_PATHS[i]!)
    if (existsSync(abs)) {
      parts.push(readFileSync(abs, 'utf8'))
    }
  }
  const dir = checkDir(repoRoot)
  const scripts = checkScripts(repoRoot)
  for (let i = 0, { length } = scripts; i < length; i += 1) {
    parts.push(readFileSync(path.join(dir, scripts[i]!), 'utf8'))
  }
  return parts.join('\n')
}

/**
 * The checks nothing runs.
 */
export function inertChecks(repoRoot: string = REPO_ROOT): readonly string[] {
  const text = runnerText(repoRoot)
  const out: string[] = []
  const scripts = checkScripts(repoRoot)
  for (let i = 0, { length } = scripts; i < length; i += 1) {
    const name = scripts[i]!
    if (OFF_RUNNER_CHECKS[name] !== undefined) {
      continue
    }
    // A runner names the file. Its own source mentions itself in the @file
    // header and SCRIPT_META, so those are excluded above by reading runners
    // and OTHER checks - a self-mention cannot wire anything.
    const others = text.split(readSelf(repoRoot, name)).join('')
    if (!others.includes(name)) {
      out.push(name)
    }
  }
  return out
}

function readSelf(repoRoot: string, name: string): string {
  const abs = path.join(checkDir(repoRoot), name)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '\u0000'
}

export interface CheckResult {
  readonly message: string
  readonly name: string
  readonly passed: boolean
}

export function checksAreWired(repoRoot: string = REPO_ROOT): {
  passed: boolean
  results: CheckResult[]
} {
  const scripts = checkScripts(repoRoot)
  if (scripts.length === 0) {
    return {
      passed: true,
      results: [
        {
          message: 'no scripts/fleet/check/ in this repo, so nothing to wire.',
          name: 'check directory is present',
          passed: true,
        },
      ],
    }
  }
  const inert = inertChecks(repoRoot)
  if (inert.length > 0) {
    return {
      passed: false,
      results: [
        {
          message:
            `${inert.length} check(s) that no runner invokes: ${inert.join(', ')}. ` +
            'Saw: a script that reads as coverage and catches nothing; wanted every check reachable from preflight or the release steps. ' +
            'Fix: add it to preflight.mts or check-steps-release.mts, or delete it. If something outside this repo runs it, name it in OFF_RUNNER_CHECKS with the reason.',
          name: 'every check is reachable from a runner',
          passed: false,
        },
      ],
    }
  }
  return {
    passed: true,
    results: [
      {
        message: `${scripts.length} checks, all reachable from a runner.`,
        name: 'every check is reachable from a runner',
        passed: true,
      },
    ],
  }
}

export async function main(): Promise<number> {
  const quiet = process.argv.includes('--quiet')
  const { passed, results } = checksAreWired()
  if (!quiet) {
    for (let i = 0, { length } = results; i < length; i += 1) {
      const result = results[i]!
      logger.info(`  ${result.passed ? '✓' : '✗'} ${result.message}`)
    }
  }
  if (!passed) {
    if (quiet) {
      logger.error('checks-are-wired: inert checks found')
    }
    return 1
  }
  return 0
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'verifies every fleet check is reachable from a runner, so none sits inert',
  help: `Usage: node scripts/fleet/check/checks-are-wired.mts [--quiet]

  --quiet  print only a failure summary

A check nothing runs reads as coverage, passes review, costs maintenance and
catches nothing. This scans scripts/fleet/check/ and fails on any script that
no runner names.

Fix an inert check by wiring it into preflight.mts or check-steps-release.mts,
or by deleting it. A check invoked only by a hook or a workflow is legitimate
but must say so in OFF_RUNNER_CHECKS, with the reason, rather than being
tolerated silently.`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
