/**
 * @file Scenario definitions for the bench evaluator. Each scenario
 *   pairs a real-world fixture with a task function and lightweight assertions.
 *   The decision-task scenarios (hoist, security-fix, weekly-update) and their
 *   factories live in `decision-scenarios.mts`; this module owns the shared
 *   rubric, the inline scenarios, and the aggregate `allScenarios`.
 */

import { Type } from '@sinclair/typebox'
import type { Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

import { majorityResult } from '../best-of-n.mts'
import { generateVerified } from '../generate-verify.mts'
import { findRedundantPackages } from '../lockfile-scan.mts'
import { findSbomAnomalies } from '../sbom-scan.mts'
import { dedupeDependencies } from '../tasks/dedupe.mts'
import { generateCodePatch } from '../tasks/patch.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'
import {
  DECISION_SAMPLES,
  hoistAmbiguousScenario,
  hoistNodeAboveMinScenario,
  hoistNodeOnlyScenario,
  hoistRealBreakingScenario,
  securityFixMinimalScenario,
  securityFixNoSafeScenario,
  securityFixSkipVulnerableScenario,
  weeklyUpdateInSoakScenario,
  weeklyUpdateMixedScenario,
  weeklyUpdatePastSoakScenario,
} from './decision-scenarios.mts'
import {
  ALTERNATIVE_PACKAGE_PROMPT,
  ASK_QUERIES,
  CODE_PATCH_INPUT,
  CODE_REPAIR_INPUT,
  CODE_REPAIR_LINT_ERRORS,
  LOCKFILE_DEDUPE_CANDIDATE,
  LOCKFILE_DUPLICATE_LODASH,
  MANIFEST_DEDUPE_CANDIDATE,
  SBOM_ANOMALY_INPUT,
  SEVERITY_COUNTS,
} from './fixtures.mts'
import {
  isTemplateLiteralPatch,
  repairResolvesLintErrors,
} from './verify-oracles.mts'

export {
  hoistScenario,
  securityFixScenario,
  weeklyUpdateScenario,
} from './decision-scenarios.mts'

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
  run(model: OdaiModel): Promise<ScenarioResult>
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

const AlertSummarySchemaObject = Type.Object({
  sentences: Type.Array(Type.String()),
  topConcern: Type.String(),
})

const AlertSummarySchema = schemaLike(AlertSummarySchemaObject)

// The command field is grounded to the real intent set so a constrained-decoding
// backend cannot drift off the CLI's command vocabulary.
const AskIntentSchemaObject = Type.Object({
  command: Type.Array(
    Type.Union([
      Type.Literal('fix'),
      Type.Literal('scan'),
      Type.Literal('optimize'),
      Type.Literal('info'),
    ]),
  ),
  confidence: Type.Number(),
  intent: Type.String(),
})

const AskIntentSchema = schemaLike(AskIntentSchemaObject)

const CodeRepairSchema = schemaLike(
  Type.Object({
    explanation: Type.String(),
    fixed: Type.String(),
  }),
)

const SafeAlternativeSchemaObject = Type.Object({
  alternative: Type.String(),
  reasoning: Type.String(),
})

const SafeAlternativeSchema = schemaLike(SafeAlternativeSchemaObject)

export const alertSummaryScenario: Scenario = {
  name: 'alert-summary-severity-counts',
  async run(model) {
    const prompt = [
      'You are explaining aggregate software supply-chain findings.',
      'Respond with compact JSON: { "sentences": string[], "topConcern": string }.',
      'Use only the counts below; do not invent package names or CVEs.',
      'Include one sentence that states the number of critical findings.',
      `Critical: ${SEVERITY_COUNTS.critical}`,
      `High: ${SEVERITY_COUNTS.high}`,
      `Medium: ${SEVERITY_COUNTS.medium}`,
      `Low: ${SEVERITY_COUNTS.low}`,
    ].join('\n')
    const samples = []
    for (let i = 0; i < DECISION_SAMPLES; i += 1) {
      samples.push(
        // Self-consistency samples are intentionally sequential.
        // oxlint-disable-next-line no-await-in-loop -- sequential samples
        await model.promptStructured(prompt, {
          prefill: '{"sentences":["',
          responseConstraint: AlertSummarySchemaObject,
          schema: AlertSummarySchema,
          systemPrompt:
            'You are a concise security-assistant. Output valid JSON only.',
        }),
      )
    }
    const result = majorityResult(samples, value =>
      value.sentences.some(s => /critical/i.test(s)) ? 'critical' : 'none',
    )
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
    const samples = []
    for (let i = 0; i < DECISION_SAMPLES; i += 1) {
      samples.push(
        // Self-consistency samples are intentionally sequential.
        // oxlint-disable-next-line no-await-in-loop -- sequential samples
        await model.promptStructured(prompt, {
          prefill: '{"intent":"',
          responseConstraint: AskIntentSchemaObject,
          schema: AskIntentSchema,
          systemPrompt: 'You are a command-router. Output valid JSON only.',
        }),
      )
    }
    const result = majorityResult(samples, value => value.command[0] ?? '')
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
    const result = await generateVerified(
      () =>
        generateCodePatch(model, CODE_PATCH_INPUT, 'use a template literal'),
      isTemplateLiteralPatch,
      5,
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

export const codeRepairScenario: Scenario = {
  name: 'code-repair-lint-errors',
  async run(model) {
    const prompt = [
      'Fix every reported lint error in this file.',
      'Respond with compact JSON: { "fixed": string, "explanation": string }.',
      '"fixed" is the complete corrected file with no other changes.',
      'File: resolve-config.js',
      CODE_REPAIR_INPUT,
      'Lint errors:',
      CODE_REPAIR_LINT_ERRORS,
    ].join('\n')
    const result = await generateVerified(
      () =>
        model.promptStructured(prompt, {
          prefill: '{"fixed":"',
          schema: CodeRepairSchema,
          systemPrompt:
            'You are a code-repair assistant. Output valid JSON only.',
        }),
      value => repairResolvesLintErrors(value, CODE_REPAIR_LINT_ERRORS),
      5,
    )
    return scoreTaskResult(result, value => {
      const fixed = value.fixed
      const usesStrictEquality = /name\s*===\s*(""|'')/.test(fixed)
      const removedUnusedImport = !fixed.includes('deepEqual')
      const keptLogic =
        fixed.includes('join(root, ') && fixed.includes('default.json')
      const failures: string[] = []
      if (!usesStrictEquality) {
        failures.push('eqeqeq not fixed')
      }
      if (!removedUnusedImport) {
        failures.push('unused deepEqual import not removed')
      }
      if (!keptLogic) {
        failures.push('original join logic not preserved')
      }
      return {
        ok: failures.length === 0,
        assertion:
          failures.length === 0
            ? 'fixed file passes the lint re-check'
            : `expected lint-clean repair: ${failures.join('; ')}`,
      }
    })
  },
}

export const dedupeCandidateScenario: Scenario = {
  name: 'dedupe-chalk-gradient',
  async run(model) {
    const samples = []
    for (let i = 0; i < DECISION_SAMPLES; i += 1) {
      samples.push(
        // Self-consistency samples are intentionally sequential.
        // oxlint-disable-next-line no-await-in-loop -- sequential samples
        await dedupeDependencies(
          model,
          MANIFEST_DEDUPE_CANDIDATE,
          LOCKFILE_DEDUPE_CANDIDATE,
        ),
      )
    }
    const result = majorityResult(samples, value =>
      (value.suggestions as Array<{ packages: string[] }>).some(s =>
        s.packages.some(p => /chalk/i.test(p)),
      )
        ? 'chalk'
        : 'none',
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
  // Deterministic: `findRedundantPackages` scans the lockfile in code, so the
  // verdict never depends on the model.
  async run() {
    const findings = findRedundantPackages(LOCKFILE_DUPLICATE_LODASH)
    const hasLodash = findings.some(f => /lodash/i.test(f.name))
    return {
      assertion: hasLodash
        ? 'found lodash-related finding'
        : 'expected a lodash-related finding',
      name: 'lockfile-duplicate-lodash',
      ok: hasLodash,
      raw: JSON.stringify(findings),
      score: hasLodash ? 1 : 0,
    }
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
      responseConstraint: SafeAlternativeSchemaObject,
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
  // Deterministic: `findSbomAnomalies` scans the component list in code, so the
  // verdict never depends on the model.
  async run() {
    const anomalies = findSbomAnomalies(SBOM_ANOMALY_INPUT)
    const mentionsDuplicate = anomalies.some(a =>
      /duplicate|multiple|two versions/i.test(a),
    )
    return {
      assertion: mentionsDuplicate
        ? 'flagged duplicate component versions'
        : 'expected duplicate-version anomaly',
      name: 'sbom-anomaly-detection',
      ok: mentionsDuplicate,
      raw: JSON.stringify(anomalies),
      score: mentionsDuplicate ? 1 : 0,
    }
  },
}

export const allScenarios: Scenario[] = [
  alertSummaryScenario,
  askIntentScenario,
  codePatchScenario,
  codeRepairScenario,
  dedupeCandidateScenario,
  hoistAmbiguousScenario,
  hoistNodeAboveMinScenario,
  hoistNodeOnlyScenario,
  hoistRealBreakingScenario,
  lockfileDuplicateScenario,
  safeAlternativeScenario,
  sbomAnomalyScenario,
  securityFixMinimalScenario,
  securityFixNoSafeScenario,
  securityFixSkipVulnerableScenario,
  weeklyUpdateInSoakScenario,
  weeklyUpdateMixedScenario,
  weeklyUpdatePastSoakScenario,
]
