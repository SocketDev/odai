/**
 * @file Allowlist parsing for the llama.cpp server conformance runner. The
 *   allowlist is a plain text file, one `<test id>  # <reason>` per line, so a
 *   diff reads as a list of justified failures instead of a code change. It
 *   never lives inline in the runner.
 */

import { existsSync, readFileSync } from 'node:fs'

import type { AllowlistEntry } from './types.mts'

/**
 * Parse allowlist text. A blank line, or one whose first non-space character
 * is `#`, is a comment. Everything after the first `#` on an entry line is the
 * reason, which is required: an unjustified entry would be an allowance with
 * no argument behind it.
 */
export function parseAllowlist(text: string): AllowlistEntry[] {
  const entries: AllowlistEntry[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0, { length } = lines; i < length; i += 1) {
    const line = lines[i]!.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    const hash = line.indexOf('#')
    if (hash === -1) {
      throw new Error(
        `Allowlist line ${i + 1} has no reason: "${line}". Every allowed ` +
          'failure carries `# <why it is allowed>` so the list stays ' +
          'reviewable.',
      )
    }
    const id = line.slice(0, hash).trim()
    const reason = line.slice(hash + 1).trim()
    if (id === '' || reason === '') {
      throw new Error(
        `Allowlist line ${i + 1} is malformed: "${line}". Expected ` +
          '`<test id>  # <reason>`.',
      )
    }
    entries.push({ id, reason })
  }
  return entries
}

/**
 * Read the allowlist file. A missing file is an empty allowlist, so a fresh
 * runner reports every failure as unexpected rather than silently passing.
 */
export function loadAllowlist(filePath: string): AllowlistEntry[] {
  if (!existsSync(filePath)) {
    return []
  }
  return parseAllowlist(readFileSync(filePath, 'utf8'))
}
