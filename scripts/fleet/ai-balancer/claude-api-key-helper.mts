#!/usr/bin/env node
/**
 * @file The command Claude Code's `apiKeyHelper` setting names.
 *
 *   Claude Code runs this and uses what it prints as the Anthropic API key.
 *   That is the whole contract, and it is what gets a session out of the wedge
 *   its expiring OAuth token puts it in: the client cannot re-auth itself, but
 *   it CAN run a command, and this command answers from the key the machine
 *   already holds.
 *
 *   WIRE IT WITH `--install`, which writes the setting into
 *   `~/.claude/settings.json` rather than asking an operator to hand-edit JSON
 *   and get the path wrong.
 *
 *   OUTPUT IS THE KEY AND NOTHING ELSE. No banner, no trailing prose, no log
 *   line. Claude Code takes stdout verbatim, so a single stray character makes
 *   every request fail authentication in a way that points nowhere. Diagnostics
 *   go to stderr under `--status`, which never prints a key at all.
 *
 *   Usage: node scripts/fleet/ai-balancer/claude-api-key-helper.mts [--status]
 *   [--install]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import {
  anthropicKeySources,
  resolveAnthropicApiKey,
} from '../_shared/anthropic-key.mts'
import { isMainModule } from '../_shared/is-main-module.mts'
import { opencodeAuthPath } from '../_shared/opencode-auth.mts'
import { runMain } from '../_shared/run-main.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

/**
 * Claude Code's settings file.
 */
export function claudeSettingsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude', 'settings.json')
}

/**
 * The value written into `apiKeyHelper`.
 *
 * An absolute path, because Claude Code runs the helper with a working
 * directory the operator does not control, and a relative path resolves
 * somewhere unpredictable.
 */
export function helperCommandFor(scriptPath: string): string {
  return `node ${scriptPath}`
}

/**
 * Merge `apiKeyHelper` into the settings file, leaving every other key alone.
 *
 * Read-modify-write rather than a template, because that file holds an
 * operator's own configuration: hooks, permissions, theme. Overwriting it to
 * add one key would be a data loss bug dressed up as a feature.
 */
export function installApiKeyHelper(config: {
  readonly command: string
  readonly settingsPath: string
}): { readonly changed: boolean; readonly previous: string | undefined } {
  const { command, settingsPath } = { __proto__: null, ...config } as {
    command: string
    settingsPath: string
  }
  let settings: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>
    }
  } catch {
    // No settings file yet, or one that does not parse. Either way the write
    // below creates a valid one; clobbering an unparseable file is the only
    // way forward and it held nothing readable anyway.
  }
  const existing = settings['apiKeyHelper']
  const previous = typeof existing === 'string' ? existing : undefined
  if (previous === command) {
    return { changed: false, previous }
  }
  settings['apiKeyHelper'] = command
  mkdirSync(path.dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify(settings, undefined, 2)}\n`, 'utf8')
  return { changed: true, previous }
}

/**
 * Report which sources hold a key, naming no key.
 */
export async function statusLines(): Promise<readonly string[]> {
  const sources = await anthropicKeySources()
  if (sources.length === 0) {
    return [
      'No Anthropic API key found.',
      `  Where: ANTHROPIC_API_KEY, the fleet keychain slot, and ${opencodeAuthPath()}.`,
      '  Saw:   no source holding a value shaped like sk-ant-…; wanted one.',
      '  Fix:   run `opencode auth login` and pick Anthropic, or export ANTHROPIC_API_KEY.',
    ]
  }
  return [
    `Anthropic API key available from: ${sources.join(', ')}.`,
    `  The helper will use ${sources[0]!}, the highest-priority source holding one.`,
  ]
}

export async function main(): Promise<number> {
  const argv = process.argv.slice(2)

  if (argv.includes('--status')) {
    const lines = await statusLines()
    for (let i = 0, { length } = lines; i < length; i += 1) {
      logger.error(lines[i]!)
    }
    return (await anthropicKeySources()).length > 0 ? 0 : 1
  }

  if (argv.includes('--install')) {
    const command = helperCommandFor(
      path.resolve(new URL(import.meta.url).pathname),
    )
    const settingsPath = claudeSettingsPath()
    const { changed, previous } = installApiKeyHelper({ command, settingsPath })
    if (!changed) {
      logger.error(`apiKeyHelper already points here in ${settingsPath}.`)
      return 0
    }
    logger.error(
      previous === undefined
        ? `Wrote apiKeyHelper into ${settingsPath}.`
        : `Repointed apiKeyHelper in ${settingsPath} (was: ${previous}).`,
    )
    logger.error(
      'Restart Claude Code so it picks the setting up. A wedged session ' +
        'will authenticate with the key instead of its expired token.',
    )
    return 0
  }

  const resolved = await resolveAnthropicApiKey()
  if (resolved === undefined) {
    // Nothing on stdout: Claude Code treats whatever it gets as the key, so an
    // error message here would be sent as a credential. The diagnosis goes to
    // stderr, where the client shows it and no request carries it.
    const lines = await statusLines()
    for (let i = 0, { length } = lines; i < length; i += 1) {
      logger.error(lines[i]!)
    }
    return 1
  }
  // The key, alone, no newline decoration beyond the one write. This is the
  // only place in the fleet that prints a credential, and it is the documented
  // contract of the setting that runs it.
  process.stdout.write(resolved.key)
  return 0
}

const SCRIPT_META: ScriptMeta = {
  describe:
    "prints an Anthropic API key for Claude Code's apiKeyHelper, so an expired OAuth session can authenticate without a browser",
  help: `Usage: node scripts/fleet/ai-balancer/claude-api-key-helper.mts [flags]

  (no flags)  print the resolved API key on stdout, and nothing else
  --status    report which sources hold a key, naming no key, on stderr
  --install   write this command into ~/.claude/settings.json as apiKeyHelper

Claude Code signs in with an OAuth token that expires, cannot renew it from
inside a session, and has no fallback configured, so an expired token wedges
the session until a human signs in again. Claude Code will instead run an
\`apiKeyHelper\` command and use its stdout as the API key.

Sources are tried in order: ANTHROPIC_API_KEY, the fleet's keychain slot, then
the key OpenCode stored at its own login. A value that is not shaped like an
Anthropic key is skipped rather than returned, so a stale OAuth token cannot
shadow a good key.`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
