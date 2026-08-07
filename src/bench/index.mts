/**
 * @file Bench evaluator. Runs a battery of small, real-world scenarios
 *   against an OdaiModel and reports pass/fail scores plus raw outputs.
 *   Designed to answer: "how well does an on-device model actually work for
 *   these tasks?"
 */

import { detectModelName } from '../model-identity.mts'
import type { OdaiModel } from '../model.mts'
import { allScenarios } from './scenarios.mts'
import type { Scenario, ScenarioResult } from './scenarios.mts'

export { allScenarios }
export type { Scenario, ScenarioResult }

// Published API shape; renaming the exported interface or reshaping the
// bag is a breaking change.
export interface EvalRunOptions {
  /**
   * When true, probe the running model's identity (an extra prompt) and record
   * it on the report as `model`. Failures are swallowed to `undefined`.
   */
  identifyModel?: boolean | undefined
  // oxlint-disable-next-line socket/no-required-in-options-bag -- public API
  model: OdaiModel
  scenarios?: Scenario[] | undefined
}

export interface EvalReport {
  /**
   * The detected model name (e.g. "Gemma 4" / "Gemini Nano") when
   * `identifyModel` was set and the probe recognized the reply, else undefined.
   */
  model?: string | undefined
  passed: number
  results: ScenarioResult[]
  score: number
  total: number
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = []
  lines.push(`odai bench: ${report.passed}/${report.total} passed`)
  if (report.model !== undefined) {
    lines.push(`model: ${report.model}`)
  }
  lines.push('')
  for (const result of report.results) {
    const icon = result.ok ? '[PASS]' : '[FAIL]'
    const timing =
      result.durationMs === undefined ? '' : ` (${result.durationMs}ms)`
    lines.push(`${icon} ${result.name}${timing}`)
    lines.push(`  assertion: ${result.assertion}`)
    lines.push(`  raw: ${truncate(result.raw, 200)}`)
    lines.push('')
  }
  lines.push(`score: ${(report.score * 100).toFixed(1)}%`)
  return lines.join('\n')
}

export async function runEval(options: EvalRunOptions): Promise<EvalReport> {
  const opts = { __proto__: null, ...options } as typeof options
  const scenarios = opts.scenarios ?? allScenarios
  const results: ScenarioResult[] = []
  for (const scenario of scenarios) {
    const startedAt = performance.now()
    const partial = await scenario.run(opts.model)
    const durationMs = Math.round(performance.now() - startedAt)
    results.push({ ...partial, durationMs, name: scenario.name })
  }
  const passed = results.reduce((acc, r) => acc + (r.ok ? 1 : 0), 0)
  let model: string | undefined
  if (opts.identifyModel) {
    try {
      const identity = await detectModelName(opts.model.rawSession())
      model = identity.name
    } catch {
      model = undefined
    }
  }
  return {
    model,
    passed,
    results,
    score: results.length > 0 ? passed / results.length : 0,
    total: results.length,
  }
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, max)}…`
}
