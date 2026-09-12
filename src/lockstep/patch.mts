export interface HunkCount {
  old: number
  next: number
}

// Capture old and new line counts. An omitted count means one line in unified diff syntax.
const hunkHeader = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/

export function consumeHunkLine(line: string, count: HunkCount): boolean {
  if (line === '\\ No newline at end of file') {
    return true
  }
  const prefix = line[0]
  if (prefix === ' ' || prefix === '-') {
    count.old -= 1
  }
  if (prefix === ' ' || prefix === '+') {
    count.next -= 1
  }
  return (
    (prefix === ' ' || prefix === '-' || prefix === '+') &&
    count.old >= 0 &&
    count.next >= 0
  )
}

export function isLockstepHunkComplete(count: HunkCount | undefined): boolean {
  return count?.old === 0 && count.next === 0
}

// Only one ordinary file diff is accepted. Git metadata could change modes or rename files.
export function isLockstepPatch(path: string, patch: string): boolean {
  if (patch.includes('\r') || patch.includes('\0') || !patch.endsWith('\n')) {
    return false
  }
  const lines = patch.slice(0, -1).split(/\r?\n/)
  if (lines[0] !== `--- a/${path}` && lines[0] !== '--- /dev/null') {
    return false
  }
  if (lines[1] !== `+++ b/${path}`) {
    return false
  }
  return validateLockstepHunks(lines.slice(2))
}

export function validateLockstepHunks(lines: string[]): boolean {
  let count: HunkCount | undefined
  let hunks = 0
  let changes = 0
  for (let i = 0, length = lines.length; i < length; i += 1) {
    const line = lines[i]!
    const header = hunkHeader.exec(line)
    if (header) {
      if (count && !isLockstepHunkComplete(count)) {
        return false
      }
      count = { old: Number(header[1] ?? 1), next: Number(header[2] ?? 1) }
      hunks += 1
    } else if (!count || !consumeHunkLine(line, count)) {
      return false
    } else if (line.startsWith('+') || line.startsWith('-')) {
      changes += 1
    }
  }
  return hunks > 0 && changes > 0 && isLockstepHunkComplete(count)
}
