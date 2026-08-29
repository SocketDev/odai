#!/usr/bin/env node
/*
 * @file Fleet check - the balancer's ladder is ranked by context capacity, and
 *   the catalog carries the windows that ranking reads.
 *
 *   The ranking is only as good as its data. `orderLadderByContext` drops a
 *   seat it knows cannot hold the turn, and under pressure it also drops a seat
 *   whose window nobody recorded, because guessing is what produced the
 *   original bug. That fail-closed rule has a cost: every catalog model missing
 *   a `contextWindow` row in `model-pricing.json` is a seat the ladder stops
 *   offering exactly when the session is large and most needs it.
 *
 *   So the backlog below is SHRINK-ONLY. A model already missing a window is
 *   recorded and tolerated; a NEW one fails this check. Burning the list down
 *   is how the ladder gets its seats back.
 *
 *   Usage: node scripts/fleet/check/balancer-routing-is-context-aware.mts
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { isMainModule } from '../_shared/is-main-module.mts'
import { MODEL_CATALOG } from '../_shared/model-catalog.mts'
import { runMain } from '../_shared/run-main.mts'
import { contextWindowFor } from '../ai-balancer/context-budget.mts'
import { REPO_ROOT } from '../paths.mts'
import { moduleImportsName } from './training-models-respect-visibility.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

/**
 * Catalog models with no recorded context window, as of this check landing.
 *
 * SHRINK-ONLY. Add a `contextWindow` to the model's row in
 * `constants/model-pricing.json` and delete its line here. Never add a line:
 * a new entry means a seat the ladder will refuse under pressure.
 *
 * The Fireworks default is on this list, which is worth saying plainly: the
 * seat that bills first is the one the ladder cannot size.
 */
export const MODELS_MISSING_CONTEXT_WINDOW: ReadonlySet<string> = new Set([
  'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731',
  'fireworks-ai/accounts/fireworks/models/gpt-oss-120b',
  'fireworks-ai/accounts/fireworks/models/qwen3p7-plus',
  'fireworks-ai/accounts/fireworks/routers/kimi-k2p7-code-fast',
  'fireworks-ai/accounts/fireworks/routers/kimi-k3-fast',
  'gpt-5.6-terra',
])

export interface CheckResult {
  readonly message: string
  readonly name: string
  readonly passed: boolean
}

/**
 * The proxy source, from the cascaded mirror when present and the template
 * otherwise, so this runs in a member repo and in the wheelhouse alike.
 */
export function readProxySource(): string | undefined {
  const mirrored = path.join(
    REPO_ROOT,
    'scripts',
    'fleet',
    'ai-balancer',
    'proxy.mts',
  )
  if (existsSync(mirrored)) {
    return readFileSync(mirrored, 'utf8')
  }
  const templated = path.join(
    REPO_ROOT,
    'template',
    'base',
    'scripts',
    'fleet',
    'ai-balancer',
    'proxy.mts',
  )
  return existsSync(templated) ? readFileSync(templated, 'utf8') : undefined
}

/**
 * Every catalog model resolves to a context window, except the recorded
 * backlog.
 */
export function checkCatalogWindows(): CheckResult {
  const providers = Object.keys(MODEL_CATALOG)
  const unlisted: string[] = []
  const fixed: string[] = []
  for (let i = 0, { length } = providers; i < length; i += 1) {
    const provider = providers[i]! as keyof typeof MODEL_CATALOG
    const { models } = MODEL_CATALOG[provider]
    for (let j = 0, count = models.length; j < count; j += 1) {
      const { id } = models[j]!
      const known = contextWindowFor(id) !== undefined
      const listed = MODELS_MISSING_CONTEXT_WINDOW.has(id)
      if (!known && !listed) {
        unlisted.push(id)
      }
      if (known && listed) {
        fixed.push(id)
      }
    }
  }
  if (unlisted.length > 0) {
    return {
      message:
        `${unlisted.length} catalog model(s) have no contextWindow and are not in the backlog: ` +
        `${unlisted.join(', ')}. ` +
        'Wanted a contextWindow row in constants/model-pricing.json, so the ladder can size the seat. ' +
        'Fix: add the window from the vendor page, or the ladder will refuse this seat under context pressure.',
      name: 'every catalog model has a recorded context window',
      passed: false,
    }
  }
  if (fixed.length > 0) {
    return {
      message:
        `${fixed.length} model(s) now have a window but are still listed as missing: ${fixed.join(', ')}. ` +
        'Fix: delete them from MODELS_MISSING_CONTEXT_WINDOW - the backlog is shrink-only and this is the shrink.',
      name: 'the missing-window backlog holds no stale entries',
      passed: false,
    }
  }
  const total = providers.reduce(
    (sum, provider) =>
      sum + MODEL_CATALOG[provider as keyof typeof MODEL_CATALOG].models.length,
    0,
  )
  return {
    message: `${total - MODELS_MISSING_CONTEXT_WINDOW.size}/${total} catalog models sized, ${MODELS_MISSING_CONTEXT_WINDOW.size} in the shrink-only backlog`,
    name: 'catalog context windows are recorded',
    passed: true,
  }
}

/**
 * A named import the proxy must carry for a feature to be wired at all.
 */
function checkProxyImports(
  source: string,
  moduleSpecifier: string,
  name: string,
): CheckResult {
  const wired = moduleImportsName(source, moduleSpecifier, name)
  return {
    message: wired
      ? `proxy.mts imports ${name}`
      : `proxy.mts does not import ${name} from ${moduleSpecifier}. ` +
        'Saw: the module present but unwired; wanted the proxy to call it on the failover path. ' +
        'Fix: import and call it where the ladder is built.',
    name: `proxy.mts wires ${name}`,
    passed: wired,
  }
}

/**
 * A call the proxy must actually make, not merely import.
 */
function checkProxyCalls(source: string, name: string): CheckResult {
  const called = source.includes(`${name}(`)
  return {
    message: called
      ? `proxy.mts calls ${name}()`
      : `proxy.mts imports ${name} but never calls it. ` +
        'Saw: a dead import; wanted the call on the failover path. ' +
        'Fix: call it where the ladder is built, before it is walked.',
    name: `proxy.mts calls ${name}()`,
    passed: called,
  }
}

export function balancerRoutingIsContextAware(): {
  passed: boolean
  results: CheckResult[]
} {
  const results: CheckResult[] = [checkCatalogWindows()]
  const source = readProxySource()
  if (source === undefined) {
    results.push({
      message:
        'proxy.mts not found in scripts/fleet/ai-balancer/ or template/base/. ' +
        'Saw: no source to read; wanted the balancer proxy. ' +
        'Fix: run the cascade so the mirror exists.',
      name: 'the balancer proxy is readable',
      passed: false,
    })
    return { passed: false, results }
  }
  results.push(
    checkProxyImports(source, './context-budget.mts', 'orderLadderByContext'),
    checkProxyImports(source, './context-budget.mts', 'estimateBodyTokens'),
    checkProxyImports(source, './context-budget.mts', 'isCompactionRequest'),
    checkProxyImports(source, './training-warning.mts', 'warnOnTrainingRung'),
    checkProxyCalls(source, 'orderLadderByContext'),
    checkProxyCalls(source, 'warnOnTrainingRung'),
  )
  return { passed: results.every(result => result.passed), results }
}

export async function main(): Promise<number> {
  const quiet = process.argv.includes('--quiet')
  const { passed, results } = balancerRoutingIsContextAware()
  if (!quiet) {
    for (let i = 0, { length } = results; i < length; i += 1) {
      const result = results[i]!
      logger.info(`  ${result.passed ? '✓' : '✗'} ${result.name}: ${result.message}`)
    }
  }
  if (!passed) {
    if (quiet) {
      const failed = results.filter(result => !result.passed).length
      logger.error(
        `balancer-routing-is-context-aware: ${failed} check(s) failed`,
      )
    }
    return 1
  }
  if (!quiet) {
    logger.info('balancer-routing-is-context-aware: all checks passed')
  }
  return 0
}

const SCRIPT_META: ScriptMeta = {
  describe:
    "verifies the balancer ranks its failover ladder by context capacity, and that the catalog carries the windows that ranking reads",
  help: `Usage: node scripts/fleet/check/balancer-routing-is-context-aware.mts [--quiet]

  --quiet  print only a failure summary

Checks that every model in MODEL_CATALOG resolves to a contextWindow in
constants/model-pricing.json, and that proxy.mts imports and calls the context
ranking and the training-rung disclosure.

A model with no window is dropped from the ladder under context pressure, so
the backlog of unsized models is shrink-only: fix one by adding its window to
the pricing data, never by adding a line to the list.`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
