import {
  createOpenCodeServer,
  hasOpenCodeSessionHooks,
} from '../_shared/opencode/server.mts'
import type { PluginContext } from '../_shared/opencode/server.mts'
import { toClaudeCodeArgs, TOOL_NAMES } from '../_shared/opencode/tool.mts'
export { TOOL_NAMES, toClaudeCodeArgs } from '../_shared/opencode/tool.mts'

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

import { safeDeleteSync } from '@socketsecurity/lib-stable/fs/safe'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'
import { getEnvValue } from '@socketsecurity/lib-stable/env/rewire'

const logger = getDefaultLogger()

function nodeBinary(): string {
  const execName = path.basename(process.execPath).toLowerCase()
  return execName === 'node' || execName === 'node.exe'
    ? process.execPath
    : 'node'
}

const GRANT_TRANSCRIPT_TURNS = 12

let grantTranscript: string | undefined

function grantTranscriptPath(): string | undefined {
  if (grantTranscript === undefined) {
    try {
      grantTranscript = path.join(
        mkdtempSync(path.join(os.tmpdir(), 'fleet-grants-')),
        'turns.jsonl',
      )
    } catch {
      grantTranscript = ''
    }
  }
  return grantTranscript || undefined
}

function recordUserTurn(text: string): void {
  const transcript = grantTranscriptPath()
  if (!transcript || !text.trim()) {
    return
  }
  try {
    const turn = JSON.stringify({
      content: text,
      origin: { kind: 'human' },
      promptSource: 'typed',
      role: 'user',
    })
    const prior = existsSync(transcript)
      ? readFileSync(transcript, 'utf8').split(/\r?\n/).filter(Boolean)
      : []
    prior.push(turn)
    writeFileSync(
      transcript,
      `${prior.slice(-GRANT_TRANSCRIPT_TURNS).join('\n')}\n`,
      'utf8',
    )
  } catch {}
}

function findCheckoutRoot(from: string): string | undefined {
  let dir = from
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

const DISPATCHER_REL = ['.claude', 'hooks', 'fleet', 'index.cjs']

const GUARD_TIMEOUT_MS = 10_000

export const UNGUARDED_TOOL_IDS: ReadonlySet<string> = new Set([
  'list',
  'lsp_diagnostics',
  'lsp_hover',
  'patch',
  'task',
  'todoread',
  'todowrite',
  'websearch',
])

export function unclassifiedToolId(tool: string): string | undefined {
  if (TOOL_NAMES[tool] !== undefined || UNGUARDED_TOOL_IDS.has(tool)) {
    return undefined
  }
  return tool
}

const reportedUnclassifiedIds = new Set<string>()

function selfSourcePath(): string {
  const self = fileURLToPath(import.meta.url)
  const root = findCheckoutRoot(path.dirname(self))
  return root ? path.relative(root, self) : self
}

export function warnUnclassifiedTool(tool: string): void {
  const unknown = unclassifiedToolId(tool)
  if (unknown === undefined || reportedUnclassifiedIds.has(unknown)) {
    return
  }
  reportedUnclassifiedIds.add(unknown)
  logger.error(
    `[fleet-guards] tool \`${unknown}\` is in neither TOOL_NAMES nor ` +
      `UNGUARDED_TOOL_IDS, so it runs UNGUARDED. Add it to one of them in ${selfSourcePath()}.`,
  )
}

export function runDispatcher(
  dispatcher: string,
  event: string,
  payload: Record<string, unknown>,
): { blocked: boolean; text: string } {
  try {
    const result = spawnSync(nodeBinary(), [dispatcher, event], {
      encoding: 'utf8',
      input: JSON.stringify(payload),
      timeout: GUARD_TIMEOUT_MS,
    })
    return {
      blocked: result.status === 2,
      text: String(result.stderr || result.stdout || '').trim(),
    }
  } catch {
    return { blocked: false, text: '' }
  }
}

export function readOutputStyle(root: string, name: string): string {
  const file = path.join(root, '.claude', 'output-styles', `${name}.md`)
  if (!existsSync(file)) {
    return ''
  }
  try {
    const raw = readFileSync(file, 'utf8')
    const body = raw.startsWith('---')
      ? raw.slice(raw.indexOf('---', 3) + 3)
      : raw
    return body.trim()
  } catch {
    return ''
  }
}

const PROSE_HOOK_NAMES: readonly string[] = [
  'anti-prose-guard',
  'convo-prose-nudge',
  'outbound-voice-nudge',
  'reply-prose-nudge',
  'self-narration-nudge',
]

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
  let dir = ''
  try {
    const bundle = path.join(
      path.dirname(dispatcher),
      '_dist',
      'fleet-pack.generated.cjs',
    )
    if (
      !readFileSync(bundle, 'utf8').includes('fleet-dispatch-single-hook-v1')
    ) {
      logger.warn(
        'fleet-guards: prose review unavailable; rebuild the hook bundle for single-hook dispatch.',
      )
      return ''
    }
    dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-prose-'))
    const transcript = path.join(dir, 'turn.jsonl')
    writeFileSync(
      transcript,
      `${JSON.stringify({
        message: { content: [{ text, type: 'text' }] },
        role: 'assistant',
      })}\n`,
      'utf8',
    )
    const input = JSON.stringify({
      cwd: root,
      hook_event_name: 'Stop',
      transcript_path: transcript,
    })
    const findings: string[] = []
    for (let i = 0, { length } = PROSE_HOOK_NAMES; i < length; i += 1) {
      const hook = PROSE_HOOK_NAMES[i]!
      const result = spawnSync(nodeBinary(), [dispatcher, 'Stop', hook], {
        encoding: 'utf8',
        input,
        timeout: GUARD_TIMEOUT_MS,
      })
      if (result.status === 0 || result.status === 2) {
        const finding = `${result.stderr || ''}\n${result.stdout || ''}`.trim()
        if (finding) {
          findings.push(`[${hook}] ${finding}`)
        }
      } else if (result.status !== 3) {
        logger.warn(
          `fleet-guards: prose hook ${hook} failed; inspect the dispatcher.`,
        )
      }
    }
    return findings.join('\n')
  } catch {
    logger.warn(
      'fleet-guards: prose review failed; inspect the hook bundle and scratch directory permissions.',
    )
    return ''
  } finally {
    if (dir) {
      try {
        safeDeleteSync(dir)
      } catch {
        logger.warn(
          'fleet-guards: prose transcript cleanup failed; check scratch directory permissions.',
        )
      }
    }
  }
}

async function registerCatalog(
  root: string,
  catalog: NonNullable<PluginContext['catalog']>,
): Promise<() => Promise<void>> {
  const loaded: {
    registerOpenCodeCatalogPolicy: (
      catalog: NonNullable<PluginContext['catalog']>,
    ) => Promise<() => Promise<void>>
  } = await import(
    pathToFileURL(
      path.join(root, 'scripts/fleet/ai/balancer/opencode/catalog.mts'),
    ).href
  )
  return loaded.registerOpenCodeCatalogPolicy(catalog)
}

function dispatchTool(
  root: string,
  dispatcher: string,
  event: 'PostToolUse' | 'PreToolUse',
  tool: string,
  args: unknown,
): void {
  const toolName = TOOL_NAMES[tool]
  if (!toolName || !existsSync(dispatcher)) {
    warnUnclassifiedTool(tool)
    return
  }
  const result = runDispatcher(dispatcher, event, {
    cwd: root,
    tool_input: toClaudeCodeArgs(args) ?? {},
    tool_name: toolName,
    transcript_path: grantTranscriptPath(),
  })
  if (event === 'PreToolUse' && result.blocked) {
    throw new Error(result.text)
  }
  if (result.text) {
    logger.warn(result.text)
  }
}

export const FleetGuards = {
  id: 'fleet-guards',
  async server() {
    const root = findCheckoutRoot(import.meta.dirname)
    if (!root) {
      throw new Error('Fleet guards require a Git checkout.')
    }
    const dispatcher = path.join(root, ...DISPATCHER_REL)
    const policy: { assertProviderAllowed: (reference: unknown) => void } =
      await import(
        pathToFileURL(
          path.join(root, 'scripts/fleet/ai/balancer/provider-policy.mts'),
        ).href
      )
    const models: {
      filterOpenCodeV1Models: (
        config: Record<string, unknown>,
        settings: ReadonlyArray<Record<string, unknown>>,
      ) => void
    } = await import(
      pathToFileURL(
        path.join(root, 'scripts/fleet/ai/balancer/opencode/models.mts'),
      ).href
    )
    const start = runDispatcher(dispatcher, 'SessionStart', {
      cwd: root,
      hook_event_name: 'SessionStart',
    })
    if (start.text) {
      logger.info(start.text)
    }
    return createOpenCodeServer({
      tool(event, name, args) {
        dispatchTool(root, dispatcher, event, name, args)
      },
      prompt(text) {
        recordUserTurn(text)
        const result = runDispatcher(dispatcher, 'UserPromptSubmit', {
          cwd: root,
          hook_event_name: 'UserPromptSubmit',
          prompt: text,
          transcript_path: grantTranscriptPath(),
        })
        if (result.text) {
          logger.warn(result.text)
        }
      },
      style() {
        return readOutputStyle(
          root,
          getEnvValue('FLEET_OUTPUT_STYLE') || 'fleet',
        )
      },
      review(text) {
        const result = reviewAssistantProse(dispatcher, root, text)
        if (result) {
          logger.warn(result)
        }
      },
      reviewFailure() {
        logger.warn('Fleet prose review failed; inspect the hook dispatcher.')
      },
      model(reference) {
        policy.assertProviderAllowed(reference)
      },
      config(config) {
        models.filterOpenCodeV1Models(config, [config])
      },
    })
  },
  setup(ctx: PluginContext | Pick<PluginContext, 'catalog' | 'location'>) {
    const root = findCheckoutRoot(import.meta.dirname)
    if (root === undefined) {
      logger.warn(
        `fleet-guards: no git checkout above ${import.meta.dirname} — guards are OFF for this session.`,
      )
      return undefined
    }
    if (!hasOpenCodeSessionHooks(ctx)) {
      if (!ctx.catalog) {
        throw new Error('OpenCode plugin context has no supported APIs.')
      }
      return registerCatalog(root, ctx.catalog)
    }
    const dispatcher = path.join(root, ...DISPATCHER_REL)
    const sessionStart = runDispatcher(dispatcher, 'SessionStart', {
      cwd: root,
      hook_event_name: 'SessionStart',
    })
    if (sessionStart.text) {
      logger.info(sessionStart.text)
    }
    const controller = new AbortController()
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
      } catch {}
    })()
    const registration = ctx.tool.hook('execute.before', event => {
      dispatchTool(root, dispatcher, 'PreToolUse', event.tool, event.input)
    })
    void ctx.tool.hook('execute.after', event => {
      dispatchTool(root, dispatcher, 'PostToolUse', event.tool, event.input)
    })

    void ctx.session.hook('prompt', event => {
      const prompt = String(event?.prompt?.text ?? '')
      recordUserTurn(prompt)
      if (!existsSync(dispatcher)) {
        return
      }
      const spoke = runDispatcher(dispatcher, 'UserPromptSubmit', {
        cwd: root,
        hook_event_name: 'UserPromptSubmit',
        prompt,
        transcript_path: grantTranscriptPath(),
      })
      if (spoke.text) {
        logger.warn(spoke.text)
      }
    })

    const styleName = getEnvValue('FLEET_OUTPUT_STYLE') || 'fleet'
    const styleText = readOutputStyle(root, styleName)
    if (styleText) {
      void ctx.session.hook('context', event => {
        event.system?.push({ text: styleText, type: 'text' })
      })
    }

    void registration
    if (ctx.catalog) {
      return registerCatalog(root, ctx.catalog)
        .then(dispose => async () => {
          controller.abort()
          await dispose()
        })
        .catch(error => {
          controller.abort()
          throw error
        })
    }

    return () => controller.abort()
  },
}

export default FleetGuards
