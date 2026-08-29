/**
 * @file Reader for OpenCode's credential store.
 *
 *   OpenCode keeps the keys established by its own `opencode auth login` in a
 *   JSON file rather than the OS keychain, so the fleet's `foreign` credential
 *   slot mechanism - which reads a keychain service and account - cannot see
 *   them. This module is the file-backed equivalent: signing in THERE is
 *   enough, and no operator copies a key by hand into a second place where it
 *   can drift.
 *
 *   WHY THIS EXISTS AT ALL. Claude Code authenticates with an OAuth token that
 *   expires. When it expires mid-session the client has no way to re-auth
 *   itself and no way to fall back, so the session wedges: every turn fails
 *   and the only fix is for a human to notice and sign in again. An API key is
 *   the escape hatch that needs no browser, and the operator already has one
 *   sitting in OpenCode's store.
 *
 *   THE VALUE IS A SECRET. Nothing here logs a key, formats one into a
 *   message, or returns one anywhere but to the caller that asked. The only
 *   sanctioned way a key leaves this process is the api-key helper's stdout,
 *   which is the contract Claude Code defines for exactly this purpose.
 */

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * One provider entry in OpenCode's `auth.json`.
 *
 * `type` distinguishes a raw API key from an OAuth grant. Only `api` carries a
 * usable `key`; an `oauth` entry holds a token with its own expiry and is not
 * what this module is for.
 */
export interface OpencodeAuthEntry {
  readonly key?: string | undefined
  readonly type?: string | undefined
}

/**
 * The directory OpenCode stores its data under.
 *
 * `XDG_DATA_HOME` wins when set, which is both the spec and what makes this
 * testable without touching a real home directory. Otherwise the XDG default,
 * which is where OpenCode puts it on macOS and Linux alike.
 */
export function opencodeDataDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const xdg = env['XDG_DATA_HOME']
  const base = xdg ? xdg : path.join(homeDir, '.local', 'share')
  return path.join(base, 'opencode')
}

/**
 * Where OpenCode's credential file sits.
 */
export function opencodeAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return path.join(opencodeDataDir(env, homeDir), 'auth.json')
}

/**
 * Every provider entry OpenCode holds.
 *
 * An absent, unreadable, or malformed file is an EMPTY store, not an error.
 * This is a fallback source: a machine with no OpenCode installed is a normal
 * machine, and the caller's next fallback should run rather than the process
 * dying over a file it only hoped to find.
 */
export function readOpencodeAuth(
  authPath: string = opencodeAuthPath(),
): Readonly<Record<string, OpencodeAuthEntry>> {
  let raw: string
  try {
    raw = readFileSync(authPath, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }
  return parsed as Record<string, OpencodeAuthEntry>
}

/**
 * The API key OpenCode holds for a provider, or undefined.
 *
 * Only an `api` entry answers. An `oauth` entry is skipped on purpose: its
 * token expires, and handing a soon-to-expire token to a client as though it
 * were a durable key rebuilds the wedge this module exists to prevent.
 */
export function readOpencodeApiKey(
  provider: string,
  authPath: string = opencodeAuthPath(),
): string | undefined {
  const entry = readOpencodeAuth(authPath)[provider]
  if (!entry || entry.type !== 'api') {
    return undefined
  }
  const { key } = entry
  return typeof key === 'string' && key.length > 0 ? key : undefined
}

/**
 * Which providers OpenCode holds an API key for.
 *
 * Names only, never values, so this is safe to print in a status report.
 */
export function opencodeApiKeyProviders(
  authPath: string = opencodeAuthPath(),
): readonly string[] {
  const auth = readOpencodeAuth(authPath)
  const providers = Object.keys(auth)
  const out: string[] = []
  for (let i = 0, { length } = providers; i < length; i += 1) {
    const provider = providers[i]!
    const entry = auth[provider]
    if (entry?.type === 'api' && entry.key) {
      out.push(provider)
    }
  }
  return out.sort()
}
