/**
 * @file Changelog provenance helper. The hoist/dedupe tasks assess against
 *   release-notes-shaped text, and every caller should not hand-assemble
 *   that text: the strongest source wins, and the source travels with the
 *   result so a verdict's provenance is never invisible.
 *   Source ladder: the installed package's own CHANGELOG.md (strongest),
 *   then the npm registry README for the target version (marketing-mixed),
 *   then 'none' when neither exists.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { httpRequest } from '@socketsecurity/lib-stable/http-request'

export type ChangelogSource = 'local-changelog' | 'none' | 'registry-readme'

export type ChangelogResult = {
  /**
   * Where the text came from - label this in any verdict that used it.
   */
  source: ChangelogSource
  text: string
}

export type FetchChangelogOptions = {
  /**
   * Project root holding node_modules, which enables the local source.
   */
  root?: string | undefined
  /**
   * Target version for the registry README; defaults to the latest tag.
   */
  version?: string | undefined
}

const CHANGELOG_NAMES = ['CHANGELOG.md', 'CHANGELOG', 'HISTORY.md']
const MAX_TEXT = 8000

/**
 * Release-notes-shaped text for `name`, with its provenance. Registry access
 * is the public npm endpoint, unauthenticated, timeout-bounded - a network
 * miss is 'none', never an error the caller must handle.
 */
export async function fetchChangelog(
  name: string,
  options?: FetchChangelogOptions | undefined,
): Promise<ChangelogResult> {
  const opts = { __proto__: null, ...options } as FetchChangelogOptions

  if (typeof opts.root === 'string' && opts.root.length > 0) {
    const local = readLocalChangelog(opts.root, name)
    if (local !== undefined) {
      return local
    }
  }

  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@').replace('%2F', '/')}`
    const response = await httpRequest(url, {
      headers: { accept: 'application/json' },
      timeout: 10_000,
    })
    if (response.status !== 200) {
      return { source: 'none', text: '' }
    }
    const packument = JSON.parse(response.body.toString('utf8')) as {
      readme?: string | undefined
      versions?: Record<string, { readme?: string | undefined }> | undefined
    }
    const versioned =
      typeof opts.version === 'string'
        ? packument.versions?.[opts.version]?.readme
        : undefined
    const text = (versioned ?? packument.readme ?? '').slice(0, MAX_TEXT)
    return text.length > 0
      ? { source: 'registry-readme', text }
      : { source: 'none', text: '' }
  } catch {
    return { source: 'none', text: '' }
  }
}

export function readLocalChangelog(
  root: string,
  name: string,
): ChangelogResult | undefined {
  const pkgDir = path.join(root, 'node_modules', name)
  for (let i = 0, { length } = CHANGELOG_NAMES; i < length; i += 1) {
    const file = CHANGELOG_NAMES[i]!
    const candidate = path.join(pkgDir, file)
    if (existsSync(candidate)) {
      try {
        return {
          source: 'local-changelog',
          text: readFileSync(candidate, 'utf8').slice(0, MAX_TEXT),
        }
      } catch {
        return undefined
      }
    }
  }
  return undefined
}
