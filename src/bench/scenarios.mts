/**
 * @file Scenario definitions for the bench evaluator. Each scenario
 *   pairs a real-world fixture with a task function and lightweight assertions.
 */

import { Type } from '@sinclair/typebox'
import type { Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

import { dedupeDependencies } from '../tasks/dedupe.mts'
import { reasonAboutLockfile } from '../tasks/lockfile.mts'
import { generateCodePatch } from '../tasks/patch.mts'
import type { GeminiNanoModel } from '../model.mts'
import type { TaskResult } from '../types.mts'
import {
  ALTERNATIVE_PACKAGE_PROMPT,
  ASK_QUERIES,
  CODE_PATCH_INPUT,
  LOCKFILE_DEDUPE_CANDIDATE,
  LOCKFILE_DUPLICATE_LODASH,
  MANIFEST_DEDUPE_CANDIDATE,
  SBOM_ANOMALY_INPUT,
  SEVERITY_COUNTS,
} from './fixtures.mts'

export interface ScenarioResult {
  assertion?: string | undefined
  /**
   * Wall-clock milliseconds the scenario's prompt round-trip took. Filled in
   * by `runEval`; scenarios never set it themselves.
   */
  durationMs?: number | undefined
  name: string
  ok: boolean
  raw: string
  score: number
}

export interface Scenario {
  name: string
  run(model: GeminiNanoModel): Promise<ScenarioResult>
}

export function schemaLike<T extends ReturnType<typeof Type.Object>>(
  schema: T,
) {
  return {
    parse(value: unknown): Static<T> {
      return Value.Parse(schema, value)
    },
  }
}

export function scoreTaskResult<T>(
  result: TaskResult<T>,
  assert: (value: T) => { assertion: string; ok: boolean },
): ScenarioResult {
  if (!result.ok || result.data === undefined) {
    return {
      assertion: result.error ?? 'task failed',
      name: '',
      ok: false,
      raw: result.raw,
      score: 0,
    }
  }
  const verdict = assert(result.data)
  return {
    assertion: verdict.assertion,
    name: '',
    ok: verdict.ok,
    raw: result.raw,
    score: verdict.ok ? 1 : 0,
  }
}

const AlertSummarySchema = schemaLike(
  Type.Object({
    sentences: Type.Array(Type.String()),
    topConcern: Type.String(),
  }),
)

const AskIntentSchema = schemaLike(
  Type.Object({
    command: Type.Array(Type.String()),
    confidence: Type.Number(),
    intent: Type.String(),
  }),
)

const SafeAlternativeSchema = schemaLike(
  Type.Object({
    alternative: Type.String(),
    reasoning: Type.String(),
  }),
)

const SbomAnomalySchema = schemaLike(
  Type.Object({
    anomalies: Type.Array(Type.String()),
    summary: Type.String(),
  }),
)

export const alertSummaryScenario: Scenario = {
  name: 'alert-summary-severity-counts',
  async run(model) {
    const prompt = [
      'You are explaining aggregate software supply-chain findings.',
      'Respond with compact JSON: { "sentences": string[], "topConcern": string }.',
      'Use only the counts below; do not invent package names or CVEs.',
      `Critical: ${SEVERITY_COUNTS.critical}`,
      `High: ${SEVERITY_COUNTS.high}`,
      `Medium: ${SEVERITY_COUNTS.medium}`,
      `Low: ${SEVERITY_COUNTS.low}`,
    ].join('\n')
    const result = await model.promptStructured(prompt, {
      prefill: '{"sentences":["',
      schema: AlertSummarySchema,
      systemPrompt:
        'You are a concise security-assistant. Output valid JSON only.',
    })
    return scoreTaskResult(result, value => {
      const sentences = value.sentences
      const hasCritical = sentences.some(s => /critical/i.test(s))
      return {
        ok: hasCritical,
        assertion: hasCritical
          ? 'summary mentions critical findings'
          : 'expected summary to mention critical findings',
      }
    })
  },
}

export const askIntentScenario: Scenario = {
  name: 'ask-intent-classification',
  async run(model) {
    const query = ASK_QUERIES[1]!
    const prompt = [
      'Classify the user intent for a supply-chain security CLI.',
      'Respond with compact JSON: { "intent": string, "command": string[], "confidence": number }.',
      `Query: "${query}"`,
    ].join('\n')
    const result = await model.promptStructured(prompt, {
      prefill: '{"intent":"',
      schema: AskIntentSchema,
      systemPrompt: 'You are a command-router. Output valid JSON only.',
    })
    return scoreTaskResult(result, value => {
      const command = value.command
      const isFix = command[0] === 'fix'
      return {
        ok: isFix,
        assertion: isFix
          ? `routed "${query}" to fix command`
          : `expected "${query}" to route to fix command, got ${JSON.stringify(command)}`,
      }
    })
  },
}

export const codePatchScenario: Scenario = {
  name: 'code-patch-template-literal',
  async run(model) {
    const result = await generateCodePatch(
      model,
      CODE_PATCH_INPUT,
      'use a template literal',
    )
    return scoreTaskResult(result, value => {
      const patch = value.patch
      const hasTemplate = patch.includes('`Hello ${name}`')
      return {
        ok: hasTemplate,
        assertion: hasTemplate
          ? 'produced template-literal patch'
          : 'expected template-literal patch',
      }
    })
  },
}

export const dedupeCandidateScenario: Scenario = {
  name: 'dedupe-chalk-gradient',
  async run(model) {
    const result = await dedupeDependencies(
      model,
      MANIFEST_DEDUPE_CANDIDATE,
      LOCKFILE_DEDUPE_CANDIDATE,
    )
    return scoreTaskResult(result, value => {
      const suggestions = value.suggestions as Array<{ packages: string[] }>
      const mentionsChalk = suggestions.some(s =>
        s.packages.some(p => /chalk/i.test(p)),
      )
      return {
        ok: mentionsChalk,
        assertion: mentionsChalk
          ? 'suggested chalk deduplication'
          : 'expected chalk deduplication suggestion',
      }
    })
  },
}

export const lockfileDuplicateScenario: Scenario = {
  name: 'lockfile-duplicate-lodash',
  async run(model) {
    const result = await reasonAboutLockfile(model, LOCKFILE_DUPLICATE_LODASH)
    return scoreTaskResult(result, value => {
      const findings = value.findings as Array<{
        package: string
        reason: string
      }>
      const hasLodash = findings.some(f => /lodash/i.test(f.package))
      return {
        ok: hasLodash,
        assertion: hasLodash
          ? 'found lodash-related finding'
          : 'expected a lodash-related finding',
      }
    })
  },
}

export const safeAlternativeScenario: Scenario = {
  name: 'safe-alternative-suggestion',
  async run(model) {
    const prompt = [
      'Suggest a safe alternative to a flagged package.',
      'Respond with compact JSON: { "alternative": string, "reasoning": string }.',
      ALTERNATIVE_PACKAGE_PROMPT,
    ].join('\n')
    const result = await model.promptStructured(prompt, {
      prefill: '{"alternative":"',
      schema: SafeAlternativeSchema,
      systemPrompt: 'You are a dependency-advisor. Output valid JSON only.',
    })
    return scoreTaskResult(result, value => {
      const alternative = value.alternative
      const isLodashEs = /lodash-es/i.test(alternative)
      return {
        ok: isLodashEs,
        assertion: isLodashEs
          ? 'suggested lodash-es alternative'
          : `expected lodash-es alternative, got ${alternative}`,
      }
    })
  },
}

export const sbomAnomalyScenario: Scenario = {
  name: 'sbom-anomaly-detection',
  async run(model) {
    const prompt = [
      'Identify anomalies in this SBOM component list.',
      'Respond with compact JSON: { "summary": string, "anomalies": string[] }.',
      SBOM_ANOMALY_INPUT,
    ].join('\n')
    const result = await model.promptStructured(prompt, {
      prefill: '{"summary":"',
      schema: SbomAnomalySchema,
      systemPrompt: 'You are a supply-chain analyst. Output valid JSON only.',
    })
    return scoreTaskResult(result, value => {
      const anomalies = value.anomalies
      const mentionsDuplicate = anomalies.some(a =>
        /duplicate|multiple|two versions/i.test(a),
      )
      return {
        ok: mentionsDuplicate,
        assertion: mentionsDuplicate
          ? 'flagged duplicate component versions'
          : 'expected duplicate-version anomaly',
      }
    })
  },
}

export const allScenarios: Scenario[] = [
  alertSummaryScenario,
  askIntentScenario,
  codePatchScenario,
  dedupeCandidateScenario,
  lockfileDuplicateScenario,
  safeAlternativeScenario,
  sbomAnomalyScenario,
]
