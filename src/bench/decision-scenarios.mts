/**
 * @file Decision-task scenarios for the bench evaluator. Each decision task —
 *   cross-major hoist safety, Dependabot security-fix selection, and the weekly
 *   soak-gated update plan — pairs a fenced, data-only fixture with a task
 *   function and a rubric that scores the model's verdict. The shared rubric
 *   (`scoreTaskResult`) and the `Scenario` shape live in `scenarios.mts`.
 */

import { assessHoistSafety } from '../tasks/hoist.mts'
import { assessSecurityFix } from '../tasks/security-fix.mts'
import { planWeeklyUpdate } from '../tasks/weekly-update.mts'
import { scoreTaskResult } from './scenarios.mts'
import type { HoistVerdict } from '../prompts/hoist.mts'
import type {
  SecurityFixInput,
  SecurityFixVerdict,
} from '../prompts/security-fix.mts'
import type { WeeklyUpdateInput } from '../prompts/weekly-update.mts'
import type { Scenario } from './scenarios.mts'
import {
  HOIST_AMBIGUOUS_CHANGELOG,
  HOIST_MIN_NODE_MAJOR,
  HOIST_NODE_ABOVE_MIN_CHANGELOG,
  HOIST_NODE_ONLY_CHANGELOG,
  HOIST_REAL_BREAKING_CHANGELOG,
  SECURITY_FIX_MINIMAL_INPUT,
  SECURITY_FIX_NO_SAFE_INPUT,
  SECURITY_FIX_SKIP_VULNERABLE_INPUT,
  WEEKLY_UPDATE_IN_SOAK_INPUT,
  WEEKLY_UPDATE_MIXED_INPUT,
  WEEKLY_UPDATE_PAST_SOAK_INPUT,
} from './fixtures.mts'

export const DECISION_SAMPLES = 5

export function hoistScenario(
  name: string,
  changelog: string,
  targetVersion: string,
  expected: HoistVerdict,
): Scenario {
  return {
    name,
    async run(model) {
      const result = await assessHoistSafety(
        model,
        {
          changelog,
          currentVersion: '2.0.0',
          minNodeSupported: HOIST_MIN_NODE_MAJOR,
          targetVersion,
        },
        { samples: DECISION_SAMPLES },
      )
      return scoreTaskResult(result, value => {
        const ok = value.verdict === expected
        return {
          assertion: ok
            ? `verdict "${value.verdict}" matches expected`
            : `expected "${expected}", got "${value.verdict}"`,
          ok,
        }
      })
    },
  }
}

export function securityFixScenario(
  name: string,
  input: SecurityFixInput,
  expectedVerdict: SecurityFixVerdict,
  expectedFixedVersion?: string | undefined,
): Scenario {
  return {
    name,
    async run(model) {
      const result = await assessSecurityFix(model, input, {
        samples: DECISION_SAMPLES,
      })
      return scoreTaskResult(result, value => {
        const ok =
          value.verdict === expectedVerdict &&
          value.fixedVersion === expectedFixedVersion
        return {
          assertion: ok
            ? `verdict "${value.verdict}" and fixedVersion "${value.fixedVersion}" match expected`
            : `expected verdict "${expectedVerdict}" fixedVersion "${expectedFixedVersion}", got verdict "${value.verdict}" fixedVersion "${value.fixedVersion}"`,
          ok,
        }
      })
    },
  }
}

export function weeklyUpdateScenario(
  name: string,
  input: WeeklyUpdateInput,
  expectedNames: string[],
): Scenario {
  return {
    name,
    async run(model) {
      const result = await planWeeklyUpdate(model, input, {
        samples: DECISION_SAMPLES,
      })
      return scoreTaskResult(result, value => {
        const names = value.updates.map(entry => entry.name)
        const missing = expectedNames.filter(n => !names.includes(n))
        const unexpected = names.filter(n => !expectedNames.includes(n))
        const ok = missing.length === 0 && unexpected.length === 0
        return {
          assertion: ok
            ? `updates match expected names ${JSON.stringify(expectedNames)}`
            : `expected updates ${JSON.stringify(expectedNames)}, got ${JSON.stringify(names)}`,
          ok,
        }
      })
    },
  }
}

export const hoistNodeOnlyScenario = hoistScenario(
  'hoist-node-only-drop-safe',
  HOIST_NODE_ONLY_CHANGELOG,
  '3.0.0',
  'safe',
)

export const hoistRealBreakingScenario = hoistScenario(
  'hoist-real-breaking-unsafe',
  HOIST_REAL_BREAKING_CHANGELOG,
  '5.0.0',
  'unsafe',
)

export const hoistNodeAboveMinScenario = hoistScenario(
  'hoist-node-above-min-unsafe',
  HOIST_NODE_ABOVE_MIN_CHANGELOG,
  '4.0.0',
  'unsafe',
)

export const hoistAmbiguousScenario = hoistScenario(
  'hoist-ambiguous-abstain',
  HOIST_AMBIGUOUS_CHANGELOG,
  '2.0.0',
  'abstain',
)

export const securityFixMinimalScenario = securityFixScenario(
  'security-fix-minimal',
  SECURITY_FIX_MINIMAL_INPUT,
  'fixed',
  '9.0.0',
)

export const securityFixNoSafeScenario = securityFixScenario(
  'security-fix-no-safe-version',
  SECURITY_FIX_NO_SAFE_INPUT,
  'no-safe-version',
)

export const securityFixSkipVulnerableScenario = securityFixScenario(
  'security-fix-skip-still-vulnerable',
  SECURITY_FIX_SKIP_VULNERABLE_INPUT,
  'fixed',
  '6.2.2',
)

export const weeklyUpdateInSoakScenario = weeklyUpdateScenario(
  'weekly-update-in-soak',
  WEEKLY_UPDATE_IN_SOAK_INPUT,
  [],
)

export const weeklyUpdateMixedScenario = weeklyUpdateScenario(
  'weekly-update-mixed',
  WEEKLY_UPDATE_MIXED_INPUT,
  ['undici'],
)

export const weeklyUpdatePastSoakScenario = weeklyUpdateScenario(
  'weekly-update-past-soak',
  WEEKLY_UPDATE_PAST_SOAK_INPUT,
  ['undici'],
)
