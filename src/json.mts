/**
 * @file Structured output from a small on-device model is unreliable. This
 *   module prefills JSON, normalizes synonymous keys, and falls back to regex
 *   extraction when parsing fails outright.
 */

import type {
  Message,
  SchemaLike,
  SessionLike,
  StructuredPromptOptions,
  TaskResult,
} from './types.mts'
import { errorMessage } from '@socketsecurity/lib/errors/message'

export function buildPrefixedMessages(
  userContent: string,
  prefill: string,
  systemPrompt?: string | undefined,
): Message[] {
  const messages: Message[] = []
  if (systemPrompt !== undefined) {
    messages.push({ content: systemPrompt, role: 'system' })
  }
  messages.push({ content: userContent, role: 'user' })
  messages.push({ content: prefill, role: 'assistant' })
  return messages
}

export function findCanonicalKey(
  key: string,
  synonymMap: Record<string, string[]>,
): string {
  const lower = key.toLowerCase()
  for (const [canonical, synonyms] of Object.entries(synonymMap)) {
    if (canonical.toLowerCase() === lower) {
      return canonical
    }
    for (const synonym of synonyms) {
      if (synonym.toLowerCase() === lower) {
        return canonical
      }
    }
  }
  return key
}

export function mergePrefill(prefill: string, raw: string): string {
  const trimmed = raw.trimStart()
  const trimmedPrefill = prefill.trimEnd()
  if (trimmed.startsWith(trimmedPrefill)) {
    return raw
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return raw
  }
  return prefill + raw
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the generic return is the API contract: callers pick the normalized shape; returning unknown would push an unsafe cast to every call site.
export function normalizeKeys<T>(
  value: unknown,
  synonymMap: Record<string, string[]>,
): T {
  if (value === undefined || value === null || typeof value !== 'object') {
    return value as T
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeKeys(item, synonymMap)) as T
  }
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, sourceValue] of Object.entries(source)) {
    const canonical = findCanonicalKey(key, synonymMap)
    result[canonical] = normalizeKeys(sourceValue, synonymMap)
  }
  return result as T
}

export function parseJsonWithFallback<T>(
  raw: string,
  schema: SchemaLike<T>,
  synonymMap?: Record<string, string[]> | undefined,
): T {
  let trimmed = raw.trim()
  // Match a markdown code fence: opening ``` optionally followed by `json`,
  // then optional whitespace (\s*), then a lazy capture of any content
  // including newlines ([\s\S]*?), then the closing ```.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch && fenceMatch[1] !== undefined) {
    trimmed = fenceMatch[1].trim()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const repaired = repairJson(trimmed)
    parsed = JSON.parse(repaired)
  }

  const normalized =
    synonymMap !== undefined && synonymMap !== null
      ? normalizeKeys<T>(parsed, synonymMap)
      : (parsed as T)
  return schema.parse(normalized)
}

export async function promptStructured<T>(
  session: SessionLike,
  userContent: string,
  options: StructuredPromptOptions<T>,
): Promise<TaskResult<T>> {
  const opts = { __proto__: null, ...options } as typeof options
  const messages = buildPrefixedMessages(
    userContent,
    opts.prefill,
    opts.systemPrompt,
  )
  if (opts.initialPrompts !== undefined && opts.initialPrompts.length > 0) {
    messages.unshift(...opts.initialPrompts)
  }
  const raw = await session.prompt(messages)
  const merged = mergePrefill(opts.prefill, raw)
  try {
    const data = parseJsonWithFallback<T>(merged, opts.schema, opts.synonymMap)
    return { data, ok: true, raw: merged }
  } catch (error) {
    const message = errorMessage(error)
    return { error: message, ok: false, raw: merged }
  }
}

export function repairJson(raw: string): string {
  // Try to extract the first balanced JSON object.
  const start = raw.indexOf('{')
  if (start === -1) {
    return '{}'
  }
  let depth = 0
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i]
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return raw.slice(start, i + 1)
      }
    }
  }
  return '{}'
}
