#!/usr/bin/env node
/**
 * @file Launch the fff MCP server (fast, frecency-ranked file search) from the
 *   wheelhouse rack, proxying stdio through untouched.
 *   WHY A LAUNCHER RATHER THAN `"command": "fff-mcp"`. The binary is racked at
 *   `~/.socket/_wheelhouse/bin`, which is on the OPERATOR's interactive PATH
 *   and nowhere else. An MCP client spawns its servers with a sanitized
 *   environment, so a bare command name resolves in a terminal and fails under
 *   the client — silently. The server never starts and the tools simply do not
 *   appear, which reads as "the integration is broken" rather than "the binary
 *   was not on the spawn PATH". Diagnosed exactly that way: `fff-mcp` answered
 *   `initialize` and `tools/list` correctly by hand while the `fff` namespace
 *   stayed empty.
 *   The absolute path cannot go in `.mcp.json` directly: its argv does not
 *   expand `$HOME`, the same constraint the playwright launcher documents, and
 *   a literal `/Users/<user>/…` in a cascaded file is a personal path on a
 *   fleet-shared surface.
 *   `node` is the right entry point because it is already proven to resolve
 *   under the client: the `fleet` and `janus-multi` servers launch that way and
 *   register fine, while the bare-command server did not.
 *   stdio is INHERITED, never piped. MCP is JSON-RPC over stdin/stdout, so the
 *   child must own the real descriptors; piping would add a buffering layer
 *   between the client and the server for no reason and risk truncating a
 *   message at exit.
 */

import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { isMainModule } from '../_shared/is-main-module.mts'
import { runMain } from '../_shared/run-main.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

/**
 * Where the fleet racks the binary. A shim, so the version it points at is the
 * rack's business rather than this file's.
 */
export function rackedFffPath(home: string = os.homedir()): string {
  return path.join(home, '.socket', '_wheelhouse', 'bin', 'fff-mcp')
}

/**
 * The command to run: the racked shim when it is there, otherwise the bare
 * name so a machine that racks fff elsewhere still works.
 */
export function resolveFffCommand(
  home: string = os.homedir(),
  exists: (p: string) => boolean = existsSync,
): string {
  const racked = rackedFffPath(home)
  return exists(racked) ? racked : 'fff-mcp'
}

export async function main(): Promise<number> {
  const command = resolveFffCommand()
  // Everything after the script's own argv is forwarded, so a client that
  // passes server flags keeps working.
  const forwarded = process.argv.slice(2)
  try {
    const child = spawn(command, forwarded, { stdio: 'inherit' })
    const result = await child
    return typeof result.code === 'number' ? result.code : 0
  } catch {
    // The server not starting is the whole failure this file exists to prevent,
    // so it is reported rather than swallowed: a silent exit is what made the
    // original breakage look like a client bug.
    process.stderr.write(
      `launch-fff-mcp: could not start the fff MCP server.\n` +
        `  Where: ${command}\n` +
        `  Saw:   the command did not run; wanted an MCP server on stdio.\n` +
        `  Fix:   rack it with the fleet external-tools installer, or put ` +
        `fff-mcp on PATH.\n`,
    )
    return 1
  }
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'launch the fff MCP server from the wheelhouse rack, proxying stdio to the client',
  help: 'Usage: node scripts/fleet/mcp/launch-fff-mcp.mts [server flags…]',
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
