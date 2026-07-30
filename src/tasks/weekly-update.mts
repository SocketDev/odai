/**
 * @file Weekly dependency-update plan task. The model EXTRACTS each outdated
 *   dependency into a structured candidate (name, from, to,
 *   days-since-published); deterministic code (`decideWeeklyUpdate`) applies
 *   the soak gate and flags major crossings. Keeping the day-count and major
 *   comparisons in code makes the on-device plan reliable.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import { majorityResult } from '../best-of-n.mts'
import {
  createWeeklyUpdatePrompt,
  WEEKLY_UPDATE_FEW_SHOT,
  WEEKLY_UPDATE_PREFILL,
  WEEKLY_UPDATE_SYNONYM_MAP,
  WEEKLY_UPDATE_SYSTEM_PROMPT,
} from '../prompts/weekly-update.mts'
import type {
  WeeklyUpdateCandidate,
  WeeklyUpdateEntry,
  WeeklyUpdateExtraction,
  WeeklyUpdateInput,
  WeeklyUpdatePlan,
} from '../prompts/weekly-update.mts'
import { parseSemverParts } from '../semver.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type {
  WeeklyUpdateCandidate,
  WeeklyUpdateExtraction,
  WeeklyUpdateInput,
  WeeklyUpdatePlan,
}

const WeeklyUpdateExtractionSchema = Type.Object(
  {
    candidates: Type.Array(
      Type.Object(
        {
          daysSincePublished: Type.Number(),
          from: Type.String(),
          name: Type.String(),
          to: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

const WeeklyUpdateExtractionSchemaLike = {
  parse(value: unknown): WeeklyUpdateExtraction {
    const parsed: Static<typeof WeeklyUpdateExtractionSchema> = Value.Parse(
      WeeklyUpdateExtractionSchema,
      value,
    )
    return {
      candidates: parsed.candidates.map(candidate => ({
        daysSincePublished: candidate.daysSincePublished,
        from: candidate.from,
        name: candidate.name,
        to: candidate.to,
      })),
    }
  },
}

/**
 * Apply the soak gate to the extracted candidates. Pure: the model never
 * compares the day count to the window or the majors to each other. Keeps a
 * candidate only when it has soaked at least `soakWindowDays`; a kept bump
 * whose target major exceeds its source major is called out in the reason.
 */
export function decideWeeklyUpdate(
  candidates: WeeklyUpdateCandidate[],
  soakWindowDays: number,
): WeeklyUpdatePlan {
  const updates: WeeklyUpdateEntry[] = []
  for (let i = 0, { length } = candidates; i < length; i += 1) {
    const candidate = candidates[i]!
    if (candidate.daysSincePublished < soakWindowDays) {
      continue
    }
    const fromMajor = parseSemverParts(candidate.from).major
    const toMajor = parseSemverParts(candidate.to).major
    const soakNote = `latest ${candidate.to} has soaked ${candidate.daysSincePublished} days, past the ${soakWindowDays}-day window`
    const reason =
      toMajor > fromMajor
        ? `${soakNote}; crosses a major version from ${fromMajor} to ${toMajor}.`
        : `${soakNote}.`
    updates.push({
      from: candidate.from,
      name: candidate.name,
      reason,
      to: candidate.to,
    })
  }
  return { updates }
}

export interface WeeklyUpdatePlanOptions {
  samples?: number | undefined
}

export async function planWeeklyUpdate(
  model: OdaiModel,
  input: WeeklyUpdateInput,
  options?: WeeklyUpdatePlanOptions | undefined,
): Promise<TaskResult<WeeklyUpdatePlan>> {
  const opts = { __proto__: null, ...options } as typeof options
  async function runOnce(): Promise<TaskResult<WeeklyUpdatePlan>> {
    const extraction = await model.promptStructured<WeeklyUpdateExtraction>(
      createWeeklyUpdatePrompt(input),
      {
        initialPrompts: [
          { content: WEEKLY_UPDATE_SYSTEM_PROMPT, role: 'system' },
          ...WEEKLY_UPDATE_FEW_SHOT,
        ],
        prefill: WEEKLY_UPDATE_PREFILL,
        responseConstraint: WeeklyUpdateExtractionSchema,
        schema: WeeklyUpdateExtractionSchemaLike,
        synonymMap: WEEKLY_UPDATE_SYNONYM_MAP,
      },
    )
    if (!extraction.ok || extraction.data === undefined) {
      return { error: extraction.error, ok: false, raw: extraction.raw }
    }
    return {
      data: decideWeeklyUpdate(
        extraction.data.candidates,
        input.soakWindowDays,
      ),
      ok: true,
      raw: extraction.raw,
    }
  }
  const samples = opts?.samples ?? 1
  if (samples <= 1) {
    return runOnce()
  }
  const results: Array<TaskResult<WeeklyUpdatePlan>> = []
  for (let i = 0; i < samples; i += 1) {
    results.push(await runOnce())
  }
  return majorityResult(results, data =>
    data.updates
      .map(u => u.name)
      .toSorted()
      .join(','),
  )
}
