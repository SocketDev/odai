/**
 * @file Cache for a pinned fleet-pack's release-bundle manifest.
 *
 *   WHY THIS IS SAFE TO CACHE FOREVER. A pin is `fleet-pack-<40-hex-sha>`, and
 *   that tag is content-addressed: it names one immutable pack. The tag cannot
 *   be repointed the way `latest` can, so the manifest behind a given ref never
 *   changes. There is no staleness to reason about and no TTL to tune - a hit
 *   is correct by construction, and a new pin is simply a new key.
 *
 *   WHAT IT SAVES. `member-fetcher-matches-pinned-pack` pulls the pinned pack
 *   to read ONE field out of its manifest. The pack's tarball layer measures
 *   10,324,459 bytes, and that check runs on every `pnpm run check --all` and
 *   every preflight. Caching the parsed manifest turns every run after the
 *   first, for as long as the pin holds, into a local file read.
 *
 *   The cache lives beside the other per-checkout fleet state rather than in a
 *   per-user store, because it is keyed to the pin recorded in THIS checkout's
 *   settings file. Two worktrees on different pins must not share an answer.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { FLEET_CACHE_DIR } from '../paths.mts'

/**
 * Where a cached manifest for `ref` sits.
 *
 * One file per ref, named by the ref, so a pin change is a cache miss and
 * never a stale hit.
 */
export const PINNED_MANIFEST_CACHE_DIR = path.join(
  FLEET_CACHE_DIR,
  'socket-wheelhouse',
  'pinned-manifest',
)

/**
 * How many cached manifests to keep.
 *
 * Each is roughly 445 KB, and only the current pin is ever read. A handful are
 * kept so that hopping between two branches on different pins does not refetch
 * 10 MB each time, and the rest are pruned so a long-lived checkout does not
 * accumulate a manifest per cascade forever.
 */
export const PINNED_MANIFEST_CACHE_KEEP = 4

/**
 * Whether a string is a fleet-pack ref, and therefore safe as a filename.
 *
 * Checked rather than assumed: the ref reaches here from a settings file an
 * operator can edit, and a value with a path separator in it would write
 * outside the cache directory. A ref that does not match is simply not cached.
 */
export function isCacheableRef(ref: string): boolean {
  return /^fleet-pack-[0-9a-f]{40}$/.test(ref)
}

export function cachedManifestPath(ref: string): string {
  return path.join(PINNED_MANIFEST_CACHE_DIR, `${ref}.json`)
}

/**
 * The cached manifest for `ref`, or undefined on a miss.
 *
 * A file that does not parse is a miss, not an error. The cache is an
 * optimisation, so every failure mode degrades to fetching.
 */
export function readCachedPinnedManifest(ref: string): unknown | undefined {
  if (!isCacheableRef(ref)) {
    return undefined
  }
  const file = cachedManifestPath(ref)
  if (!existsSync(file)) {
    return undefined
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Record the manifest for `ref`, then prune the oldest entries.
 *
 * Never throws. A cache that cannot be written is a cache that does not exist,
 * and the caller has the answer in hand either way.
 */
export function writeCachedPinnedManifest(ref: string, manifest: unknown): void {
  if (!isCacheableRef(ref)) {
    return
  }
  try {
    mkdirSync(PINNED_MANIFEST_CACHE_DIR, { recursive: true })
    writeFileSync(
      cachedManifestPath(ref),
      `${JSON.stringify(manifest)}\n`,
      'utf8',
    )
    prunePinnedManifestCache()
  } catch {
    // Read-only checkout, full disk, or a race with another worktree. The
    // check still has its answer; only the saving failed.
  }
}

/**
 * Keep the newest {@link PINNED_MANIFEST_CACHE_KEEP} entries, drop the rest.
 */
export function prunePinnedManifestCache(
  keep: number = PINNED_MANIFEST_CACHE_KEEP,
): void {
  let entries: string[]
  try {
    entries = readdirSync(PINNED_MANIFEST_CACHE_DIR)
  } catch {
    return
  }
  const rows: { file: string; mtimeMs: number }[] = []
  for (let i = 0, { length } = entries; i < length; i += 1) {
    const name = entries[i]!
    if (!name.endsWith('.json')) {
      continue
    }
    const file = path.join(PINNED_MANIFEST_CACHE_DIR, name)
    try {
      rows.push({ file, mtimeMs: statSync(file).mtimeMs })
    } catch {
      // Vanished under us; nothing to prune.
    }
  }
  if (rows.length <= keep) {
    return
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (let i = keep, { length } = rows; i < length; i += 1) {
    try {
      rmSync(rows[i]!.file, { force: true })
    } catch {
      // Another worktree pruned it first.
    }
  }
}
