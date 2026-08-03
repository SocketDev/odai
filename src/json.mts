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

export function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

export function mergePrefill(prefill: string, raw: string): string {
  const trimmed = raw.trimStart()
  const trimmedPrefill = prefill.trimEnd()
  if (trimmed.startsWith(trimmedPrefill)) {
    return raw
  }
  // The model continued from the prefill's open bracket without echoing it, so
  // raw alone is unbalanced but prefill+raw parses — e.g. prefill `{"updates":[`
  // + raw `{…}]}`. A small model does this with a nested-array prefill. Prefer
  // the combination only when it actually repairs the structure.
  if (!isParseableJson(trimmed) && isParseableJson(prefill + raw)) {
    return prefill + raw
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return raw
  }
  return prefill + raw
}

/**
 * Replace fullwidth and typographic JSON punctuation with the ASCII forms.
 * Small on-device models emit `，`, `：`, and curly quotes mid-structure —
 * observed live from Gemini Nano at temperature 0 — and strict JSON.parse
 * rejects them. Only runs on the repair path, after a strict parse already
 * failed, so a legitimate curly quote inside a string value can at worst
 * leave the reply as unparseable as it started.
 */
export function normalizeJsonPunctuation(raw: string): string {
  return raw
    .replaceAll('\u{FF0C}', ',')
    .replaceAll('\u{FF1A}', ':')
    .replaceAll('\u{FF1B}', ';')
    .replaceAll(/[\u{201C}\u{201D}]/gu, '"')
    .replaceAll(/[\u{2018}\u{2019}]/gu, "'")
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
    const normalized = normalizeJsonPunctuation(trimmed)
    try {
      parsed = JSON.parse(normalized)
    } catch {
      // Double-escaped output: some models emit `{\"k\": \"v\"}` — a
      // string-encoded object. Unescaping only helps when it then parses; a
      // false unescape (no `\"` present, or a genuinely broken reply) leaves
      // it as unparseable as it started and falls through to the repair pass.
      const unescaped = unescapeJsonQuotes(normalized)
      try {
        parsed = JSON.parse(unescaped)
      } catch {
        parsed = JSON.parse(repairJson(unescaped))
      }
    }
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
  const promptOptions =
    opts.responseConstraint !== undefined
      ? { responseConstraint: opts.responseConstraint }
      : undefined
  const attempts = (opts.retries ?? 2) + 1
  let lastError = 'model returned no parseable response'
  let lastRaw = ''
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const raw = await session.prompt(messages, promptOptions)
    const merged = mergePrefill(opts.prefill, raw)
    lastRaw = merged
    if (merged.trim() === '') {
      lastError = 'model returned an empty response'
      continue
    }
    try {
      const data = parseJsonWithFallback<T>(
        merged,
        opts.schema,
        opts.synonymMap,
      )
      return { data, ok: true, raw: merged }
    } catch (error) {
      lastError = errorMessage(error)
    }
  }
  return { error: lastError, ok: false, raw: lastRaw }
}

/**
 * Extract the first JSON object from `raw`, repairing the one container-close
 * mistake observed live from Gemini Nano: a `}` closing over a still-open
 * array gets the missing `]` injected first. String-aware (a brace inside a
 * string value never miscounts depth). Input that ENDS with an open string
 * or open containers is NOT repaired — that shape is stream truncation, and
 * closing it would fabricate content (a tool call cut off mid-string must
 * stay rejectable), so the documented `{}` give-up applies exactly as it
 * does when no object is found. Well-formed input passes through
 * byte-identical; the caller still strict-parses the result.
 */
export function repairJson(raw: string): string {
  const start = raw.indexOf('{')
  if (start === -1) {
    return '{}'
  }
  const out: string[] = []
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i]!
    if (inString) {
      out.push(char)
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out.push(char)
      continue
    }
    if (char === '[' || char === '{') {
      stack.push(char)
      out.push(char)
      continue
    }
    if (char === ']' || char === '}') {
      const wanted = char === '}' ? '{' : '['
      while (stack.length > 0 && stack[stack.length - 1] !== wanted) {
        out.push(stack.pop() === '[' ? ']' : '}')
      }
      if (stack.length === 0) {
        // An unmatched closer with nothing open — drop it.
        continue
      }
      stack.pop()
      out.push(char)
      if (stack.length === 0) {
        return out.join('')
      }
      continue
    }
    out.push(char)
  }
  return '{}'
}

/**
 * Undo backslash-escaped quotes (`\"` → `"`). Only meaningful on the repair
 * path, after a strict parse already failed: a reply with no `\"` is returned
 * unchanged, so this is a no-op for well-formed JSON and only rescues the
 * string-encoded-object shape a small model occasionally emits.
 */
export function unescapeJsonQuotes(raw: string): string {
  return raw.replaceAll('\\"', '"')
}
