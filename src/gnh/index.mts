/**
 * @file Gemini Nano Hints (gnh) evaluator. Runs a battery of small, real-world
 *   scenarios against a GeminiNanoModel and reports pass/fail scores plus raw
 *   outputs. Designed to answer: "how well does on-device Nano actually work
 *   for these tasks?"
 */

import type { GeminiNanoModel } from '../model.mts'
import { allScenarios } from './scenarios.mts'
import type { Scenario, ScenarioResult } from './scenarios.mts'

export { allScenarios }
export type { Scenario, ScenarioResult }

export interface EvalRunOptions {
  model: GeminiNanoModel
  scenarios?: Scenario[] | undefined
}

export interface EvalReport {
  passed: number
  results: ScenarioResult[]
  score: number
  total: number
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = []
  lines.push(
    `Gemini Nano Hints evaluation: ${report.passed}/${report.total} passed`,
  )
  lines.push('')
  for (const result of report.results) {
    const icon = result.ok ? '[PASS]' : '[FAIL]'
    lines.push(`${icon} ${result.name}`)
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
    const partial = await scenario.run(opts.model)
    results.push({ ...partial, name: scenario.name })
  }
  const passed = results.reduce((acc, r) => acc + (r.ok ? 1 : 0), 0)
  return {
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
