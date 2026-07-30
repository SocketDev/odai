import { describe, expect, it } from 'vitest'

import {
  isVersionAffectedByEntry,
  isVersionAffectedByRange,
  osvVulnerableVersions,
} from '../src/osv.mts'
import type { OsvAdvisory } from '../src/osv.mts'

describe('isVersionAffectedByRange', () => {
  it('marks a version inside an introduced/fixed window affected', () => {
    const range = {
      events: [{ introduced: '0' }, { fixed: '9.0.0' }],
      type: 'SEMVER',
    }
    expect(isVersionAffectedByRange(range, '8.0.1')).toBe(true)
    expect(isVersionAffectedByRange(range, '9.0.0')).toBe(false)
    expect(isVersionAffectedByRange(range, '10.0.0')).toBe(false)
  })

  it('treats an introduced with no fixed as open-ended', () => {
    const range = { events: [{ introduced: '1.0.0' }], type: 'SEMVER' }
    expect(isVersionAffectedByRange(range, '0.9.0')).toBe(false)
    expect(isVersionAffectedByRange(range, '1.0.0')).toBe(true)
    expect(isVersionAffectedByRange(range, '2.5.0')).toBe(true)
  })

  it('handles multiple windows in one range', () => {
    const range = {
      events: [
        { introduced: '0' },
        { fixed: '1.2.0' },
        { introduced: '1.5.0' },
        { fixed: '1.6.0' },
      ],
      type: 'SEMVER',
    }
    expect(isVersionAffectedByRange(range, '1.1.0')).toBe(true)
    expect(isVersionAffectedByRange(range, '1.3.0')).toBe(false)
    expect(isVersionAffectedByRange(range, '1.5.2')).toBe(true)
    expect(isVersionAffectedByRange(range, '1.6.0')).toBe(false)
  })
})

describe('isVersionAffectedByEntry', () => {
  it('matches an explicitly listed version', () => {
    const entry = { versions: ['1.2.1', '1.2.3'] }
    expect(isVersionAffectedByEntry(entry, '1.2.3')).toBe(true)
    expect(isVersionAffectedByEntry(entry, '1.2.2')).toBe(false)
  })

  it('falls through to ranges when versions do not match', () => {
    const entry = {
      ranges: [
        { events: [{ introduced: '0' }, { fixed: '2.0.0' }], type: 'SEMVER' },
      ],
      versions: ['9.9.9'],
    }
    expect(isVersionAffectedByEntry(entry, '1.5.0')).toBe(true)
    expect(isVersionAffectedByEntry(entry, '2.0.0')).toBe(false)
  })

  it('is not affected when neither versions nor ranges match', () => {
    expect(isVersionAffectedByEntry({}, '1.0.0')).toBe(false)
  })
})

describe('osvVulnerableVersions', () => {
  it('returns only the affected subset, preserving input order', () => {
    const advisory: OsvAdvisory = {
      affected: [
        {
          ranges: [
            {
              events: [{ introduced: '0' }, { fixed: '9.0.0' }],
              type: 'SEMVER',
            },
          ],
        },
      ],
    }
    expect(
      osvVulnerableVersions(advisory, ['8.0.0', '8.0.1', '9.0.0', '10.0.0']),
    ).toEqual(['8.0.0', '8.0.1'])
  })

  it('unions matches across multiple affected entries', () => {
    const advisory: OsvAdvisory = {
      affected: [
        { versions: ['6.2.1'] },
        {
          ranges: [
            {
              events: [{ introduced: '0' }, { fixed: '6.2.1' }],
              type: 'SEMVER',
            },
          ],
        },
      ],
    }
    expect(
      osvVulnerableVersions(advisory, ['6.2.0', '6.2.1', '6.2.2']),
    ).toEqual(['6.2.0', '6.2.1'])
  })

  it('returns an empty array when nothing is available', () => {
    const advisory: OsvAdvisory = {
      affected: [
        {
          ranges: [{ events: [{ introduced: '0' }], type: 'SEMVER' }],
        },
      ],
    }
    expect(osvVulnerableVersions(advisory, [])).toEqual([])
  })

  it('returns an empty array when the advisory names no affected versions', () => {
    expect(osvVulnerableVersions({ affected: [] }, ['1.0.0'])).toEqual([])
  })
})
