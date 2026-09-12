export const intentAcceptanceCriteria = Object.freeze({
  minimumActionAccuracy: 0.95,
  minimumAccuracyGain: 0.1,
  maximumWrongActions: 0,
  maximumInvalidOutputs: 0,
  maximumP95TotalMs: 5000,
  minimumHeldOutCases: 100,
})

export interface IntentObservation {
  caseId: string
  expectedActionId: string | null
  actionId: string | null | undefined
  baselineActionId?: string | null | undefined
  validOutput: boolean
  totalDurationMs: number
}

export function assessIntentQuality(
  observations: readonly IntentObservation[],
  backend: 'real' | 'simulator' | 'unverified',
  timing: 'operation' | 'warm-scenario',
) {
  const ids = new Set<string>()
  for (const observation of observations) {
    if (
      !observation.caseId ||
      ids.has(observation.caseId) ||
      !Number.isFinite(observation.totalDurationMs) ||
      observation.totalDurationMs < 0
    ) {
      throw new TypeError(
        'Invalid intent measurement. Where: held-out benchmark observations. Saw duplicate cases or invalid timing; wanted unique cases and nonnegative finite total durations. Fix: collect a fresh paired evaluation.',
      )
    }
    ids.add(observation.caseId)
  }
  const total = observations.length
  const correct = observations.filter(
    row => row.validOutput && row.actionId === row.expectedActionId,
  ).length
  const baselineMeasured =
    total > 0 && observations.every(row => row.baselineActionId !== undefined)
  const baselineCorrect = observations.filter(
    row => row.baselineActionId === row.expectedActionId,
  ).length
  const actions = observations.filter(row => row.expectedActionId !== null)
  const actionCorrect = actions.filter(
    row => row.validOutput && row.actionId === row.expectedActionId,
  ).length
  const abstentions = observations.filter(row => row.expectedActionId === null)
  const abstentionCorrect = abstentions.filter(
    row => row.validOutput && row.actionId === null,
  ).length
  const wrongActions = observations.filter(
    row =>
      row.actionId !== undefined &&
      row.actionId !== null &&
      row.actionId !== row.expectedActionId,
  ).length
  const invalidOutputs = observations.filter(row => !row.validOutput).length
  const durations = observations
    .map(row => row.totalDurationMs)
    .toSorted((left, right) => left - right)
  const p95TotalMs = durations[Math.ceil(total * 0.95) - 1] ?? 0
  const accuracy = total === 0 ? 0 : correct / total
  const baselineAccuracy = baselineMeasured
    ? baselineCorrect / total
    : undefined
  const accuracyGain = baselineMeasured
    ? (correct - baselineCorrect) / total
    : undefined
  const actionAccuracy =
    actions.length === 0 ? 0 : actionCorrect / actions.length
  const abstentionAccuracy =
    abstentions.length === 0 ? 0 : abstentionCorrect / abstentions.length
  const reasons = intentRejectionReasons({
    backend: backend,
    timing: timing,
    total,
    actionAccuracy,
    abstentionAccuracy,
    accuracyGain,
    wrongActions,
    invalidOutputs,
    p95TotalMs,
  })
  return {
    __proto__: null,
    evidence:
      backend === 'simulator'
        ? 'harness-only'
        : backend === 'real'
          ? 'real-backend'
          : 'unverified',
    timing: timing,
    eligible: reasons.length === 0,
    reasons,
    total,
    accuracy,
    baselineAccuracy,
    accuracyGain,
    actionAccuracy,
    abstentionAccuracy,
    wrongActions,
    invalidOutputs,
    p95DurationMs: p95TotalMs,
  }
}

export function intentRejectionReasons(metrics: {
  backend: 'real' | 'simulator' | 'unverified'
  timing: 'operation' | 'warm-scenario'
  total: number
  actionAccuracy: number
  abstentionAccuracy: number
  accuracyGain: number | undefined
  wrongActions: number
  invalidOutputs: number
  p95TotalMs: number
}): string[] {
  const reasons: string[] = []
  if (metrics.backend !== 'real') {
    reasons.push('No real-backend evidence.')
  }
  if (metrics.timing !== 'operation') {
    reasons.push('Warm scenario timing excludes operation setup.')
  }
  if (metrics.total < intentAcceptanceCriteria.minimumHeldOutCases) {
    reasons.push('Insufficient held-out sample count: at least 100 required.')
  }
  if (metrics.actionAccuracy < intentAcceptanceCriteria.minimumActionAccuracy) {
    reasons.push('Action accuracy is below 95%.')
  }
  if (metrics.abstentionAccuracy !== 1) {
    reasons.push('Abstention cases must all pass.')
  }
  if (metrics.accuracyGain === undefined) {
    reasons.push('Paired deterministic baseline was not measured.')
  } else if (
    metrics.accuracyGain < intentAcceptanceCriteria.minimumAccuracyGain
  ) {
    reasons.push('Accuracy gain is below 10 percentage points.')
  }
  if (metrics.wrongActions > intentAcceptanceCriteria.maximumWrongActions) {
    reasons.push('Wrong action selections were observed.')
  }
  if (metrics.invalidOutputs > intentAcceptanceCriteria.maximumInvalidOutputs) {
    reasons.push('Invalid outputs were observed.')
  }
  if (metrics.p95TotalMs > intentAcceptanceCriteria.maximumP95TotalMs) {
    reasons.push('The p95 duration exceeds 5000ms.')
  }
  return reasons
}
