/**
 * @file Tiny pure semver helpers for the deterministic decision tasks. Only the
 *   forms the decision rules need are supported: a numeric
 *   major-then-minor-then- patch compare and the simple `<X.Y.Z` / `<=X.Y.Z`
 *   affected-range tests. No semver dependency is pulled into the on-device
 *   bundle.
 */

export function compareSemverVersions(a: string, b: string): number {
  const left = parseSemverParts(a)
  const right = parseSemverParts(b)
  if (left.major !== right.major) {
    return left.major - right.major
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor
  }
  return left.patch - right.patch
}

/**
 * Test whether a version falls inside an advisory affected range. Only the two
 * simple upper-bound forms the advisories use are handled: `<X.Y.Z` (strictly
 * below) and `<=X.Y.Z` (at or below). Any other form is treated as not-matched,
 * so an unrecognized range never silently marks a version affected.
 */
export function isVersionInAffectedRange(
  version: string,
  range: string,
): boolean {
  const trimmed = range.trim()
  if (trimmed.startsWith('<=')) {
    return compareSemverVersions(version, trimmed.slice(2).trim()) <= 0
  }
  if (trimmed.startsWith('<')) {
    return compareSemverVersions(version, trimmed.slice(1).trim()) < 0
  }
  return false
}

export interface SemverParts {
  major: number
  minor: number
  patch: number
}

export function parseSemverParts(version: string): SemverParts {
  const [major = 0, minor = 0, patch = 0] = version
    .trim()
    .split('.')
    .map(part => {
      const parsed = Number.parseInt(part, 10)
      return Number.isNaN(parsed) ? 0 : parsed
    })
  return { major, minor, patch }
}
