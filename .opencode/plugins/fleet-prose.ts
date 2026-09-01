/**
 * @file OpenCode plugin - prose-review half of the fleet guard bridge. Stop
 *   runs every Stop hook and most judge repo state, so an unfiltered review is
 *   mostly noise; this keeps only what a prose hook said. Split out of
 *   `fleet-guards.ts` to keep both files under the file-size cap.
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'

/**
 * Wall-clock ceiling on one dispatcher run. A guard that hangs must not hang
 * the session.
 */
export const GUARD_TIMEOUT_MS = 10_000

/**
 * Hooks whose findings concern PROSE. Stop runs every Stop hook and most judge
 * repo state: an unfiltered review returned 2,987 measured characters, none
 * about prose. Those hooks still reach OpenCode through the Bash guards.
 */
const PROSE_HOOK_NAMES: readonly string[] = [
  'anti-prose-guard',
  'convo-prose-nudge',
  'outbound-voice-nudge',
  'reply-prose-nudge',
  'self-narration-nudge',
]

/**
 * Keep only the lines a prose hook emitted, plus their indented detail.
 */
export function keepProseFindings(output: string): string {
  const kept: string[] = []
  let inProseBlock = false
  const lines = output.split(/\r?\n/)
  for (let i = 0, { length } = lines; i < length; i += 1) {
    const line = lines[i]!
    const named = PROSE_HOOK_NAMES.some(name => line.includes(name))
    if (named) {
      inProseBlock = true
      kept.push(line)
      continue
    }
    // Continuation lines are indented or blank; a new unindented line that
    // names no prose hook belongs to some other hook.
    if (inProseBlock && (line.startsWith(' ') || line.trim() === '')) {
      kept.push(line)
      continue
    }
    inProseBlock = false
  }
  return kept.join('\n').trim()
}

export function reviewAssistantProse(
  dispatcher: string,
  root: string,
  text: string,
): string {
  if (!text.trim() || !existsSync(dispatcher)) {
    return ''
  }
  let transcript = ''
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-prose-'))
    transcript = path.join(dir, 'turn.jsonl')
    writeFileSync(
      transcript,
      `${JSON.stringify({
        message: { content: [{ text, type: 'text' }] },
        role: 'assistant',
      })}\n`,
      'utf8',
    )
  } catch {
    // No scratch space: skip the review rather than fail the session.
    return ''
  }
  try {
    const result = spawnSync(process.execPath, [dispatcher, 'Stop'], {
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: root,
        hook_event_name: 'Stop',
        transcript_path: transcript,
      }),
      timeout: GUARD_TIMEOUT_MS,
    })
    return keepProseFindings(result.stderr || result.stdout || '')
  } catch {
    // A review bug must never surface as a session failure.
    return ''
  }
}
