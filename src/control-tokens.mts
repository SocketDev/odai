/**
 * @file Chrome On-Device Internals control-token format. Chrome's built-in AI
 *   playground composes a multi-turn prompt as ONE string, with the control
 *   tokens `$SYSTEM` / `$USER` / `$MODEL` / `$END` each on their own line and
 *   the block's text on the lines between. These helpers convert between that
 *   template and odai's structured `Message[]`, so a caller can author a prompt
 *   in the same format the Chrome playground uses and feed it straight into a
 *   session's `initialPrompts`.
 *   `$MODEL` maps to the `assistant` role (Chrome names the model turn
 *   `$MODEL`; the Prompt API names it `assistant`). Text outside any block —
 *   before the first role token — is ignored, matching the playground, which
 *   only reads text that sits inside a token block.
 */

import type { Message } from './types.mts'

export const CONTROL_TOKENS = {
  end: '$END',
  model: '$MODEL',
  system: '$SYSTEM',
  user: '$USER',
} as const

const ROLE_BY_TOKEN = new Map<string, Message['role']>([
  [CONTROL_TOKENS.model, 'assistant'],
  [CONTROL_TOKENS.system, 'system'],
  [CONTROL_TOKENS.user, 'user'],
])

const TOKEN_BY_ROLE: Record<Message['role'], string> = {
  assistant: CONTROL_TOKENS.model,
  system: CONTROL_TOKENS.system,
  user: CONTROL_TOKENS.user,
}

/**
 * Render odai messages back into a Chrome control-token template — each message
 * as a `<token>` line, its content, then an `$END` line. The inverse of
 * `parseControlTokens` for round-tripping and for authoring playground input.
 */
export function formatControlTokens(messages: readonly Message[]): string {
  const blocks: string[] = []
  for (let i = 0, { length } = messages; i < length; i += 1) {
    const message = messages[i]!
    const token = TOKEN_BY_ROLE[message.role]
    blocks.push(`${token}\n${message.content}\n${CONTROL_TOKENS.end}`)
  }
  return blocks.join('\n')
}

/**
 * Parse a Chrome control-token template into odai messages. A role token
 * (`$SYSTEM` / `$USER` / `$MODEL`) on its own line opens a block; the block's
 * content is the lines up to the next role token, an `$END` line, or the end of
 * input. Blocks whose content is empty after trimming are dropped, and lines
 * before the first role token are ignored.
 */
export function parseControlTokens(template: string): Message[] {
  const messages: Message[] = []
  let role: Message['role'] | undefined
  let lines: string[] = []
  const flush = (): void => {
    if (role !== undefined) {
      const content = lines.join('\n').trim()
      if (content) {
        messages.push({ content, role })
      }
    }
    role = undefined
    lines = []
  }
  const sourceLines = template.split(/\r?\n/)
  for (let i = 0, { length } = sourceLines; i < length; i += 1) {
    const rawLine = sourceLines[i]!
    const token = rawLine.trim()
    const nextRole = ROLE_BY_TOKEN.get(token)
    if (nextRole !== undefined) {
      flush()
      role = nextRole
    } else if (token === CONTROL_TOKENS.end) {
      flush()
    } else if (role !== undefined) {
      lines.push(rawLine)
    }
  }
  flush()
  return messages
}
