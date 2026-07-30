import { describe, expect, it } from 'vitest'

import {
  findRedundantPackages,
  REDUNDANT_PAIRS,
} from '../src/lockfile-scan.mts'

describe('findRedundantPackages', () => {
  it('flags a package installed at more than one version', () => {
    const lockfile = JSON.stringify({
      packages: {
        'node_modules/chalk': { version: '5.3.0' },
        'node_modules/ansi-styles': { version: '6.2.1' },
        'node_modules/chalk/node_modules/ansi-styles': { version: '4.3.0' },
      },
    })
    const findings = findRedundantPackages(lockfile)
    const ansi = findings.find(f => f.name === 'ansi-styles')
    expect(ansi).toBeDefined()
    expect(ansi?.reason).toContain('4.3.0')
    expect(ansi?.reason).toContain('6.2.1')
  })

  it('flags a curated functional-duplicate pair when both appear', () => {
    const lockfile = JSON.stringify({
      packages: {
        'node_modules/lodash': { version: '4.17.15' },
        'node_modules/lodash-es': { version: '4.17.21' },
      },
    })
    const findings = findRedundantPackages(lockfile)
    const pair = findings.find(f => f.name === 'lodash')
    expect(pair).toBeDefined()
    expect(pair?.reason).toContain('lodash-es')
  })

  it('does not flag the pair when only one member is installed', () => {
    const lockfile = JSON.stringify({
      packages: { 'node_modules/lodash': { version: '4.17.21' } },
    })
    expect(findRedundantPackages(lockfile)).toEqual([])
  })

  it('returns nothing for a single-version tree', () => {
    const lockfile = JSON.stringify({
      packages: {
        '': { version: '1.0.0' },
        'node_modules/react': { version: '18.0.0' },
        'node_modules/react-dom': { version: '18.0.0' },
      },
    })
    expect(findRedundantPackages(lockfile)).toEqual([])
  })

  it('tolerates a lockfile with no packages block', () => {
    expect(findRedundantPackages('{}')).toEqual([])
  })

  it('exposes the lodash/lodash-es curated pair', () => {
    expect(REDUNDANT_PAIRS).toContainEqual(['lodash', 'lodash-es'])
  })
})
