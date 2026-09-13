import type { LockstepInput } from './schema.mts'

export function createLockstepCorrection(
  input: LockstepInput,
  raw: string,
  reason: string,
): string {
  return JSON.stringify({
    input,
    previousResponse: raw.slice(0, 32_000),
    validationFeedback: describeLockstepFailure(reason),
  })
}

export function describeLockstepFailure(reason: string): string {
  const explanations: Record<string, string> = {
    'lockstep:invalid-analysis':
      'Return the complete JSON proposal with exactly the declared properties and types.',
    'lockstep:invalid-change':
      'Use the exact local or test evidence ID, path, and inclusive line range. The replacement must change those lines.',
    'lockstep:invalid-citation':
      'Cite an upstream evidence ID and line interval that exists in the supplied evidence.',
    'lockstep:invalid-patch':
      'Keep edits inside the permitted implementation and test paths. Preserve the original files and valid diff structure.',
    'lockstep:missing-regression-test':
      'Include both a local implementation change and a test change that actively asserts the target behavior.',
    'lockstep:missing-target-citation':
      'Compare local behavior with upstream evidence at row.targetSha. Cite target evidence, not only the historical base. For no-change, cite every supplied target excerpt.',
  }
  return `${reason.slice(0, 2000)}${explanations[reason] ? ` ${explanations[reason]}` : ''}`
}
