/**
 * @file Dependabot security-fix decision task. The model EXTRACTS which versions
 *   the advisory names as still vulnerable beyond the machine-readable affected
 *   range; deterministic code (`decideSecurityFix`) picks the safest minimal
 *   upgrade target with a pure semver compare. Keeping the version selection in
 *   code makes the on-device verdict reliable.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createSecurityFixPrompt,
  SECURITY_FIX_FEW_SHOT,
  SECURITY_FIX_PREFILL,
  SECURITY_FIX_SYNONYM_MAP,
  SECURITY_FIX_SYSTEM_PROMPT,
} from '../prompts/security-fix.mts'
import type {
  SecurityFixAssessment,
  SecurityFixExtraction,
  SecurityFixInput,
} from '../prompts/security-fix.mts'
import { compareSemverVersions, isVersionInAffectedRange } from '../semver.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { SecurityFixAssessment, SecurityFixExtraction, SecurityFixInput }

const SecurityFixExtractionSchema = Type.Object(
  {
    alsoVulnerable: Type.Array(Type.String()),
  },
  { additionalProperties: false },
)

const SecurityFixExtractionSchemaLike = {
  parse(value: unknown): SecurityFixExtraction {
    const parsed: Static<typeof SecurityFixExtractionSchema> = Value.Parse(
      SecurityFixExtractionSchema,
      value,
    )
    return { alsoVulnerable: parsed.alsoVulnerable }
  },
}

export async function assessSecurityFix(
  model: OdaiModel,
  input: SecurityFixInput,
): Promise<TaskResult<SecurityFixAssessment>> {
  const extraction = await model.promptStructured<SecurityFixExtraction>(
    createSecurityFixPrompt(input),
    {
      initialPrompts: [
        { content: SECURITY_FIX_SYSTEM_PROMPT, role: 'system' },
        ...SECURITY_FIX_FEW_SHOT,
      ],
      prefill: SECURITY_FIX_PREFILL,
      schema: SecurityFixExtractionSchemaLike,
      synonymMap: SECURITY_FIX_SYNONYM_MAP,
    },
  )
  if (!extraction.ok || extraction.data === undefined) {
    return { error: extraction.error, ok: false, raw: extraction.raw }
  }
  return {
    data: decideSecurityFix(input, extraction.data.alsoVulnerable),
    ok: true,
    raw: extraction.raw,
  }
}

/**
 * Pick the safest minimal upgrade target from the input. Pure: the model never
 * does the semver comparison. From `input.availableVersions`, the numerically
 * lowest version that is outside `input.affectedRange` and not named in
 * `alsoVulnerable` becomes the `fixed` target; when none qualifies the verdict
 * is `no-safe-version`.
 */
export function decideSecurityFix(
  input: SecurityFixInput,
  alsoVulnerable: string[],
): SecurityFixAssessment {
  const flagged = new Set(alsoVulnerable)
  const ascending = [...input.availableVersions].toSorted(compareSemverVersions)
  const fixed = ascending.find(
    version =>
      !isVersionInAffectedRange(version, input.affectedRange) &&
      !flagged.has(version),
  )
  if (fixed === undefined) {
    return {
      fixedVersion: undefined,
      reason: `No available version is outside the affected range ${input.affectedRange} and free of advisory-flagged versions, so there is no safe upgrade.`,
      verdict: 'no-safe-version',
    }
  }
  const flaggedNote =
    alsoVulnerable.length > 0
      ? ' and is not among the advisory-flagged versions'
      : ''
  return {
    fixedVersion: fixed,
    reason: `${fixed} is the lowest available version outside the affected range ${input.affectedRange}${flaggedNote}.`,
    verdict: 'fixed',
  }
}
