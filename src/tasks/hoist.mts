/**
 * @file Cross-major hoist decision task. The model EXTRACTS the breaking
 *   changes from the target changelog (each flagged as a Node.js-drop or not,
 *   with the highest Node major it drops); deterministic code
 *   (`decideHoistVerdict`) applies the safety rule to those facts and builds
 *   the assessment. Keeping the version arithmetic in code makes the on-device
 *   verdict reliable.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createHoistPrompt,
  HOIST_FEW_SHOT,
  HOIST_PREFILL,
  HOIST_SYNONYM_MAP,
  HOIST_SYSTEM_PROMPT,
} from '../prompts/hoist.mts'
import type {
  HoistAssessment,
  HoistBreakingChange,
  HoistExtraction,
  HoistInput,
} from '../prompts/hoist.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type {
  HoistAssessment,
  HoistBreakingChange,
  HoistExtraction,
  HoistInput,
}

const HoistExtractionSchema = Type.Object(
  {
    breakingChanges: Type.Array(
      Type.Object(
        {
          droppedNodeMajor: Type.Union([Type.Number(), Type.Null()]),
          isNodeDrop: Type.Boolean(),
          text: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

const HoistExtractionSchemaLike = {
  parse(value: unknown): HoistExtraction {
    const parsed: Static<typeof HoistExtractionSchema> = Value.Parse(
      HoistExtractionSchema,
      value,
    )
    return {
      breakingChanges: parsed.breakingChanges.map(change => ({
        droppedNodeMajor: change.droppedNodeMajor ?? undefined,
        isNodeDrop: change.isNodeDrop,
        text: change.text,
      })),
    }
  },
}

export async function assessHoistSafety(
  model: OdaiModel,
  input: HoistInput,
): Promise<TaskResult<HoistAssessment>> {
  const extraction = await model.promptStructured<HoistExtraction>(
    createHoistPrompt(input),
    {
      initialPrompts: [
        { content: HOIST_SYSTEM_PROMPT, role: 'system' },
        ...HOIST_FEW_SHOT,
      ],
      prefill: HOIST_PREFILL,
      schema: HoistExtractionSchemaLike,
      synonymMap: HOIST_SYNONYM_MAP,
    },
  )
  if (!extraction.ok || extraction.data === undefined) {
    return { error: extraction.error, ok: false, raw: extraction.raw }
  }
  return {
    data: decideHoistVerdict(
      extraction.data.breakingChanges,
      input.minNodeSupported,
    ),
    ok: true,
    raw: extraction.raw,
  }
}

/**
 * Apply the hoist safety rule to the extracted breaking changes. Pure: no model
 * call, no arithmetic left to the model. `abstain` when nothing was extracted;
 * `unsafe` when any change is not a Node.js-drop or drops a Node major above
 * the project minimum; `safe` otherwise.
 */
export function decideHoistVerdict(
  changes: HoistBreakingChange[],
  minNodeSupported: number,
): HoistAssessment {
  const breakingChanges = changes.map(change => change.text)
  if (changes.length === 0) {
    return {
      breakingChanges,
      reason:
        'The changelog lists no concrete breaking change, so the hoist cannot be judged safe.',
      verdict: 'abstain',
    }
  }
  const unsafeChange = changes.find(
    change =>
      !change.isNodeDrop ||
      (change.droppedNodeMajor !== undefined &&
        change.droppedNodeMajor > minNodeSupported),
  )
  if (unsafeChange !== undefined) {
    return {
      breakingChanges,
      reason: `"${unsafeChange.text}" affects this project (a real API change or a drop of a Node.js major above the project minimum of ${minNodeSupported}), so the hoist is unsafe.`,
      verdict: 'unsafe',
    }
  }
  return {
    breakingChanges,
    reason: `Every breaking change only drops Node.js majors at or below the project minimum of ${minNodeSupported}, so the hoist is safe.`,
    verdict: 'safe',
  }
}
