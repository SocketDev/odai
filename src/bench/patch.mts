import { isLockstepPatch } from '../lockstep/patch.mts'

export interface OracleHunkOffsets {
  old: number
  next: number
}

export function applyOraclePatch(
  original: string,
  patch: string,
): string | undefined {
  const normalized = patch.endsWith('\n') ? patch : `${patch}\n`
  const lines = normalized.split(/\r?\n/)
  const header = lines[1] ?? ''
  if (
    !header.startsWith('+++ b/') ||
    !isLockstepPatch(header.slice(6), normalized)
  ) {
    return undefined
  }
  const source = splitOracleSource(original)
  const result: string[] = []
  let cursor = 0
  for (let i = 2, length = lines.length - 1; i < length; i += 1) {
    const line = lines[i]!
    const hunk = readOracleHunkOffsets(line)
    if (hunk) {
      if (hunk.old < cursor || hunk.old > source.length) {
        return undefined
      }
      result.push(...source.slice(cursor, hunk.old))
      cursor = hunk.old
      if (result.length !== hunk.next) {
        return undefined
      }
      continue
    }
    if (line.startsWith(' ') || line.startsWith('-')) {
      if (source[cursor] !== line.slice(1)) {
        return undefined
      }
      cursor += 1
    }
    if (line.startsWith(' ') || line.startsWith('+')) {
      result.push(line.slice(1))
    }
  }
  return [...result, ...source.slice(cursor)].join('\n')
}

export function readOracleHunkOffsets(
  line: string,
): OracleHunkOffsets | undefined {
  // Unified diff uses one-based line positions. Zero-count ranges name the preceding line.
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(
    line,
  )
  if (!match) {
    return undefined
  }
  return {
    old: Number(match[1]) - Number(match[2] !== '0'),
    next: Number(match[3]) - Number(match[4] !== '0'),
  }
}

export function splitOracleSource(original: string): string[] {
  if (original === '') {
    return []
  }
  const lines = original.split(/\r?\n/)
  if (original.endsWith('\n')) {
    lines.pop()
  }
  return lines
}
