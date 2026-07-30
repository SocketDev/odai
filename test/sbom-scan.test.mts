import { describe, expect, it } from 'vitest'

import { findSbomAnomalies } from '../src/sbom-scan.mts'

describe('findSbomAnomalies', () => {
  it('flags a component present at more than one version', () => {
    const anomalies = findSbomAnomalies(
      ['- pkg:npm/chalk@5.3.0', '- pkg:npm/chalk@4.1.2'].join('\n'),
    )
    expect(anomalies.some(a => /duplicate versions of chalk/i.test(a))).toBe(
      true,
    )
  })

  it('flags a deprecated component', () => {
    const anomalies = findSbomAnomalies('- pkg:npm/left-pad@1.3.0 (deprecated)')
    expect(anomalies).toContain('left-pad is marked deprecated.')
  })

  it('flags a git dependency with no pinned tag', () => {
    const anomalies = findSbomAnomalies(
      '- pkg:npm/eval-evil@1.0.0 (git dependency, no tag)',
    )
    expect(anomalies).toContain(
      'eval-evil is a git dependency with no pinned tag.',
    )
  })

  it('returns nothing when every component is clean and distinct', () => {
    const anomalies = findSbomAnomalies(
      ['- pkg:npm/lodash@4.17.21', '- pkg:npm/chalk@5.3.0'].join('\n'),
    )
    expect(anomalies).toEqual([])
  })

  it('returns nothing for empty input', () => {
    expect(findSbomAnomalies('')).toEqual([])
  })
})
