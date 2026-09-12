const protectedSegments = new Set([
  '__snapshots__',
  'allowlist',
  'allowlists',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'snapshot',
  'snapshots',
  'upstream',
])
// These names identify generated evidence or policy files, including common separator variants.
const protectedNames =
  /(?:allowlist|baseline|expected[-_]?fail|generated|lockfile|manifest|snapshot)/
// Match configuration, lock, and pin tokens without blocking words such as locking.
const protectedTokens = /(?:^|[.-])(?:config|lock|pin)(?:[.-]|$)/
// These dependency manifests and snapshot extensions must stay outside model edits.
const protectedFiles =
  /^(?:.*\.snap|cargo\.toml|go\.(?:mod|sum)|package\.json)$/

export function isLockstepArea(path: string, areas: string[]): boolean {
  return areas.some(area => path === area || path.startsWith(`${area}/`))
}

export function isLockstepPatchPath(path: string): boolean {
  if (!isLockstepPath(path)) {
    return false
  }
  const parts = path.toLowerCase().split('/')
  return !parts.some(
    part =>
      part.startsWith('.') ||
      protectedSegments.has(part) ||
      protectedNames.test(part) ||
      protectedTokens.test(part) ||
      protectedFiles.test(part),
  )
}

export function isLockstepPath(value: string): boolean {
  return (
    value.length > 0 &&
    !/[\\\s:%\x00-\x1f\x7f]/.test(value) &&
    value
      .split('/')
      .every(part => part.length > 0 && part !== '.' && part !== '..')
  )
}
