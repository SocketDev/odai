/*
 * @file Whether a push's destination branch already has an OPEN pull request
 *   with that exact head - the "you're just updating your own already-open
 *   PR" signal `no-force-push-guard` and `no-non-fleet-push-guard` use to
 *   skip their typed-phrase requirement.
 *
 *   Additive only: a failed or ambiguous check here NEVER widens permission.
 *   It answers false (no confirmed open PR), and the caller falls back to
 *   its existing, stricter behavior - the typed bypass phrase still works
 *   exactly as before. A force-push or a non-fleet push that is genuinely
 *   updating an open PR you already have out there is not the operation
 *   these guards exist to slow down; a stray push to the wrong branch or
 *   repo, where no open PR confirms intent, still is.
 */

import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'

import { spawnTimeoutMs } from './spawn-timeout.mts'

/**
 * True when `ownerRepo` (`owner/repo`) has an OPEN pull request whose head
 * branch is exactly `branch`. Bounded by a 5s timeout so a hung or
 * unauthenticated `gh` can never turn a guard into a hang; any error, empty
 * output, or non-zero exit answers false rather than throwing.
 */
export function branchHasOpenPr(
  ownerRepo: string | undefined,
  branch: string | undefined,
): boolean {
  if (!ownerRepo || !branch) {
    return false
  }
  try {
    const r = spawnSync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        ownerRepo,
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        'number',
        '--limit',
        '1',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: spawnTimeoutMs(5000),
      },
    )
    if (r.status !== 0) {
      return false
    }
    const stdout = String(r.stdout ?? '').trim()
    if (!stdout) {
      return false
    }
    const parsed: unknown = JSON.parse(stdout)
    return Array.isArray(parsed) && parsed.length > 0
    /* c8 ignore start - defensive only: gh/JSON.parse failures fall open to false */
  } catch {
    return false
  }
  /* c8 ignore stop */
}
