/**
 * @file OpenCode plugin - bridges the fleet's Claude Code guards into an
 *   OpenCode session. Copied verbatim to `.opencode/plugins/fleet-guards.ts`
 *   by `scripts/fleet/gen/harness-adapters.mts`.
 *   THE GAP THIS CLOSES. The fleet carries ~300 guards and nudges under
 *   `.claude/hooks/fleet/`, dispatched by Claude Code's PreToolUse event. An
 *   OpenCode session fires no such event, so every one of them is inert there:
 *   an agent running in OpenCode gets zero guard coverage, and the first sign
 *   is the thing a guard existed to prevent. Measured, not theorised - a
 *   session in this repo ran the exact `rg -rn` cluster that
 *   `rg-replace-flag-guard` blocks, twice, and was never stopped.
 *   OpenCode's equivalent event is the `tool.execute.before` plugin hook, and
 *   throwing from it aborts the call the way exit 2 does for Claude Code. So
 *   this is a translation, not a reimplementation: shape OpenCode's tool call
 *   into the PreToolUse payload, run the SAME dispatcher, and turn its exit 2
 *   back into a throw. One plugin, every guard.
 *   BASH ONLY, DELIBERATELY. The two hosts agree on the bash argument key
 *   (`command`), so that payload maps cleanly. They do NOT agree on the file
 *   tools: Claude Code sends `file_path` / `old_string` / `new_string` where
 *   OpenCode sends `filePath` / `oldString` / `newString`. Forwarding those
 *   unmapped would hand every file guard a payload whose fields it cannot
 *   read, and a guard that silently matches nothing is worse than one that is
 *   honestly absent. The key translation is a follow-up.
 *   FAILS OPEN, ALWAYS. A thin member has no payload until it is fetched, so a
 *   missing dispatcher is the normal state of a fresh clone, not an error. A
 *   dispatcher crash, a timeout, or a malformed payload all pass the call
 *   through: a bridge bug must never deadlock every tool call in a session.
 *   Types are structural rather than imported from `@opencode-ai/plugin`, so
 *   the plugin stays dependency-free: it loads before any install has
 *   necessarily run.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'

import { GUARD_TIMEOUT_MS, reviewAssistantProse } from './fleet-prose.ts'

const logger = getDefaultLogger()

/**
 * The checkout that `from` lives in, found by walking up to the nearest `.git`.
 *
 * Self-contained on purpose. This file is COPIED to `.opencode/plugins/` at a
 * different depth, so any relative import to a fleet helper resolves in the
 * source tree and breaks in the emitted one. Returns `undefined` when no
 * checkout is above `from`, which the caller treats as "do not guard" rather
 * than guessing at a root.
 */
export function findCheckoutRoot(from: string): string | undefined {
  let dir = from
  // A walk up cannot outlast the path's own depth.
  for (let hops = 0; hops < 64; hops += 1) {
    if (existsSync(path.join(dir, '.git'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
  return undefined
}

/**
 * The fleet hook dispatcher, relative to the repo root.
 */
const DISPATCHER_REL = ['.claude', 'hooks', 'fleet', 'index.cjs']

/**
 * How long a guard may take before the call is let through. Guards are meant
 * to be fast; a slow one must not stall the session.
 */
/**
 * OpenCode tool name to the Claude Code tool name the guards match on.
 *
 * Only bash is listed. See the file header for why the file tools are absent.
 */
/**
 * OpenCode tool id -> Claude Code tool name.
 *
 * Only tools whose payload this bridge can faithfully translate belong here.
 * A guard handed a payload whose fields it cannot read matches nothing and
 * reports nothing, which is strictly worse than being absent: it looks
 * covered.
 */
export const TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: 'Bash',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  read: 'Read',
  webfetch: 'WebFetch',
  write: 'Write',
}

/**
 * The slice of the v2 plugin context this bridge uses. Declared locally rather
 * than imported from `@opencode-ai/plugin` so the bridge stays dependency-free
 * and runs on a member that has not installed anything yet.
 */
export interface PluginContext {
  readonly event: {
    readonly subscribe: (
      options?: { signal?: AbortSignal | undefined } | undefined,
    ) => AsyncIterable<{
      data?: unknown | undefined
      type?: string | undefined
    }>
  }
  readonly location?: { readonly directory: string } | undefined
  readonly tool: {
    readonly hook: (
      name: 'execute.after' | 'execute.before',
      callback: (event: { tool: string; input: unknown }) => void,
    ) => unknown
  }
  readonly session: {
    readonly hook: (
      name: 'context' | 'prompt',
      callback: (event: {
        prompt?: { text?: string | undefined } | undefined
        // Each entry is an `LLM.SystemPart`, whose `type` is required. Typing
        // the element without it lets a `{ text }` literal compile and then
        // fail the host's schema validation, which stops the session before it
        // ever sends the request.
        system?: Array<{ text: string; type: 'text' }> | undefined
      }) => void,
    ) => unknown
  }
}

/**
 * The guard bridge, as an OpenCode v2 plugin.
 *
 * TWO SILENT-ABSENCE TRAPS LIVE IN THIS ONE FILE, both measured, both ending
 * the same way — zero guard coverage and no error anyone sees:
 *
 * 1. The EXTENSION. OpenCode discovers only `.ts`/`.js` under
 *    `.opencode/plugins/`. An identical `.mts` is never even attempted.
 * 2. The CONTRACT. v1 exported a function returning a hook map. v2 wants a
 *    DEFAULT-exported OBJECT with `setup(ctx)`, and registers tool interception
 *    through `ctx.tool.hook('execute.before', …)`. A v1-shaped plugin loads far
 *    enough to be listed and then fails schema validation with `Expected object
 *    at ["default"]` — visible only in `opencode2 plugin list` or the server
 *    log.
 *
 * A plain object is used rather than `Plugin.define` from `@opencode-ai/plugin`
 * so the bridge carries NO dependency: a thin member must be able to run it
 * before any install, and the schema accepts a plain object (measured).
 *
 * FAILS OPEN, ALWAYS. A missing dispatcher, a spawn error, or a bridge bug
 * must never deadlock a tool call — the session continues unguarded rather
 * than stuck.
 */

/**
 * The fleet output style, as system instructions.
 *
 * Claude Code applies `.claude/output-styles/<name>.md` by loading it into the
 * system prompt. OpenCode's analogue is `session.hook('context')`, whose
 * `event.system` is the assembled instruction list for the outgoing call. Same
 * lever, so this is a 1:1 bridge rather than a reimplementation — and it reads
 * the SAME file, so the two harnesses cannot drift to different house styles.
 *
 * COST. The text is identical on every request, which is what makes it cheap:
 * a stable system prefix is exactly what provider prompt caching is for, so it
 * is billed near-free after the first call of a session. It is also read from
 * disk ONCE at setup, not per request.
 */
export function readOutputStyle(root: string, name: string): string {
  const file = path.join(root, '.claude', 'output-styles', `${name}.md`)
  if (!existsSync(file)) {
    return ''
  }
  try {
    const raw = readFileSync(file, 'utf8')
    // Strip the YAML frontmatter; the body is the instruction text.
    const body = raw.startsWith('---')
      ? raw.slice(raw.indexOf('---', 3) + 3)
      : raw
    return body.trim()
  } catch {
    // A missing or unreadable style costs the style, never the session.
    return ''
  }
}

/**
 * Run the fleet's Stop-event prose guards over one assistant turn.
 *
 * WHY A SYNTHETIC TRANSCRIPT. `anti-prose-guard` and its siblings read the
 * assistant's last turn from a Claude Code JSONL transcript. OpenCode has no
 * such file — it emits the finished text as an event. Rather than teach every
 * prose guard a second input shape, the bridge writes the ONE line those
 * readers need. That is the same translation this bridge already does for tool
 * payloads, and it keeps the guards as the single source of prose law.
 *
 * OBSERVATIONAL, NOT PREVENTIVE. `session.text.ended` fires AFTER the text is
 * emitted, so this reports; it cannot refuse the turn the way Claude Code's
 * Stop hook does. That is a real capability difference between the harnesses,
 * not an implementation gap — findings surface on the next turn.
 */
/**
 * Run the fleet dispatcher for one event, returning what it said and whether
 * it refused. Exit 2 is the fleet's block signal; every other exit is advice.
 */
export function runDispatcher(
  dispatcher: string,
  event: string,
  payload: Record<string, unknown>,
): { blocked: boolean; text: string } {
  try {
    const result = spawnSync(process.execPath, [dispatcher, event], {
      encoding: 'utf8',
      input: JSON.stringify(payload),
      timeout: GUARD_TIMEOUT_MS,
    })
    return {
      blocked: result.status === 2,
      text: (result.stderr || result.stdout || '').trim(),
    }
  } catch {
    // A bridge bug must never deadlock or fail a session.
    return { blocked: false, text: '' }
  }
}

/**
 * Translate OpenCode's camelCase tool arguments into the snake_case keys the
 * Claude Code guards read.
 *
 * THE GAP THIS CLOSES. The two hosts agree on `command` for bash, which is why
 * bash worked alone for so long. They agree on nothing else: OpenCode sends
 * `filePath` / `oldString` / `newString` / `replaceAll` where every fleet
 * Edit-layer guard reads `file_path` / `old_string` / `new_string` /
 * `replace_all`. Forwarding unmapped left every file guard reading `undefined`
 * and matching nothing — silent, total non-coverage of the Edit and Write
 * surface while the bridge reported itself active.
 *
 * A general camelCase -> snake_case conversion rather than a hand-kept table:
 * a table is one more thing to forget when a tool gains an argument, and the
 * failure mode of forgetting is again silence.
 */
export function toClaudeCodeArgs(
  input: unknown,
): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    // `filePath` -> `file_path`; an already-snake_case key is unchanged.
    // oxlint-disable-next-line socket/require-regex-comment -- described above
    const snake = key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
    out[snake] = value
  }
  return out
}

export const FleetGuards = {
  id: 'fleet-guards',
  setup(ctx: PluginContext) {
    // Anchored on this FILE, not on anything the host passes and not on cwd.
    // The adapter is installed at `<repo>/.opencode/plugins/`, so its own
    // location always sits inside the checkout it guards, which makes the
    // anchor a required input with one source rather than a fallback chain.
    // `process.cwd()` names wherever the host was launched, and a build-time
    // constant names the checkout this file was AUTHORED in, which is a
    // different repo the moment the adapter cascades into a member.
    const root = findCheckoutRoot(import.meta.dirname)
    // No checkout above this file means there is nothing to guard. Fail open,
    // and say so once: silent absence here is zero guard coverage that nobody
    // sees, which is the trap the header documents twice.
    if (root === undefined) {
      logger.warn(
        `fleet-guards: no git checkout above ${import.meta.dirname} — guards are OFF for this session.`,
      )
      return undefined
    }
    const dispatcher = path.join(root, ...DISPATCHER_REL)
    const controller = new AbortController()
    // ONE review per TURN, not per text block.
    //
    // Measured from the real event stream: `session.text.ended` fires once per
    // text block, three times in a single observed turn, and
    // `session.step.ended` once per step, four times. Only
    // `session.execution.succeeded` fires ONCE, after the final step — it is
    // the true analogue of Claude Code's `Stop`, and the only event that makes
    // this bridge 1:1 rather than merely similar.
    //
    // Reviewing per block would run every Stop hook several times a turn,
    // surfacing unrelated nudges such as dirty-tree warnings on each
    // paragraph. Observed while testing, and it is how a useful signal becomes
    // noise nobody reads.
    const blocks: string[] = []
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          const type = event?.type
          if (type === 'session.text.ended') {
            const text = String(
              (event as { data?: { text?: unknown | undefined } | undefined })
                .data?.text ?? '',
            )
            if (text) {
              blocks.push(text)
            }
            continue
          }
          if (type !== 'session.execution.succeeded') {
            continue
          }
          const turn = blocks.join('\n\n')
          blocks.length = 0
          const findings = reviewAssistantProse(dispatcher, root, turn)
          if (findings) {
            logger.warn(findings)
          }
        }
      } catch {
        // A dropped stream costs the prose review, never the session.
      }
    })()
    const registration = ctx.tool.hook(
      'execute.before',
      (event: { tool: string; input: unknown }): void => {
        const toolName = TOOL_NAMES[event.tool]
        // No mapping, or a thin member whose payload is not fetched yet.
        if (!toolName || !existsSync(dispatcher)) {
          return
        }
        let result
        try {
          result = spawnSync(process.execPath, [dispatcher, 'PreToolUse'], {
            encoding: 'utf8',
            input: JSON.stringify({
              cwd: root,
              tool_input: toClaudeCodeArgs(event.input) ?? {},
              tool_name: toolName,
            }),
            timeout: GUARD_TIMEOUT_MS,
          })
        } catch {
          // A bridge bug must not deadlock every tool call.
          return
        }
        const text = (result.stderr || result.stdout || '').trim()
        // Exit 2 is the block. Throwing is how a plugin refuses a tool call,
        // and the guard's own text carries the reason and the bypass phrase.
        if (result.status === 2) {
          throw new Error(text)
        }
        // Anything else that spoke is a nudge: surface it without refusing.
        if (text) {
          logger.warn(text)
        }
      },
    )
    // PostToolUse: the fleet's after-the-call hooks, which nudge on what a
    // command DID rather than what it was about to do.
    void ctx.tool.hook('execute.after', event => {
      const toolName = TOOL_NAMES[event.tool]
      if (!toolName || !existsSync(dispatcher)) {
        return
      }
      const spoke = runDispatcher(dispatcher, 'PostToolUse', {
        cwd: root,
        tool_input: toClaudeCodeArgs(event.input) ?? {},
        tool_name: toolName,
      })
      if (spoke.text) {
        logger.warn(spoke.text)
      }
    })

    // UserPromptSubmit: the path TO the model call, where the balancer
    // watchdog and the memory nudges run. A block here is advisory only —
    // OpenCode's prompt hook shapes input, it does not refuse admission.
    void ctx.session.hook('prompt', event => {
      if (!existsSync(dispatcher)) {
        return
      }
      const spoke = runDispatcher(dispatcher, 'UserPromptSubmit', {
        cwd: root,
        hook_event_name: 'UserPromptSubmit',
        prompt: event?.prompt?.text ?? '',
      })
      if (spoke.text) {
        logger.warn(spoke.text)
      }
    })

    // Output style: the fleet's house voice, pushed into the system prompt the
    // way Claude Code applies an output style. Read once; the text is stable
    // so it caches on the provider side.
    //
    // `type: 'text'` is REQUIRED. The host validates this array against
    // `LLM.SystemPart` before it sends the request, and a part missing `type`
    // throws inside `SessionModelRequest.prepare`. That kills the whole drain
    // loop, so every turn hangs with no reply and the only trace is a
    // "Failed to drain Session" line in the server log.
    const styleName = process.env['FLEET_OUTPUT_STYLE'] || 'fleet'
    const styleText = readOutputStyle(root, styleName)
    if (styleText) {
      void ctx.session.hook('context', event => {
        event.system?.push({ text: styleText, type: 'text' })
      })
    }

    void registration
    return () => controller.abort()
  },
}

// OpenCode discovers a plugin through its default export.
// oxlint-disable-next-line socket/no-default-export -- opencode plugin contract
export default FleetGuards
