/**
 * @file Streaming inference with on-device models is slow; act on the first
 *   parseable field. This module normalizes cumulative vs delta chunks and
 *   wires abort + stale-response tags.
 */

import type { Message, SessionLike } from './types.mts'

export interface StreamOptions {
  abortSignal?: AbortSignal | undefined
  onEarlyField?:
    | ((field: { name: string; raw: string; value: unknown }) => void)
    | undefined
  /**
   * Map of field name → regex that extracts a JSON-like value as soon as it is
   * complete. The regex should capture the value in group 1.
   */
  earlyFieldPatterns?: Record<string, RegExp> | undefined
  requestId?: string | undefined
}

export interface StreamResult {
  aborted: boolean
  raw: string
  requestId?: string | undefined
  stale: boolean
}

export function isReadableStream(
  value: unknown,
): value is ReadableStream<string> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    typeof (value as ReadableStream<string>).getReader === 'function'
  )
}

export function mergeChunks(chunks: string[]): string {
  let raw = ''
  for (let i = 0, { length } = chunks; i < length; i += 1) {
    const chunk = chunks[i]!
    if (chunk.length > raw.length && chunk.startsWith(raw)) {
      raw = chunk
    } else {
      raw += chunk
    }
  }
  return raw
}

export async function readChunks(
  iterable: AsyncIterable<string> | ReadableStream<string>,
): Promise<string[]> {
  if (isReadableStream(iterable)) {
    const reader = iterable.getReader()
    const chunks: string[] = []
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      chunks.push(result.value)
    }
    return chunks
  }
  const chunks: string[] = []
  for await (const chunk of iterable) {
    chunks.push(chunk)
  }
  return chunks
}

export async function streamPrompt(
  session: SessionLike,
  messages: Message[],
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { abortSignal, onEarlyField, earlyFieldPatterns, requestId } = options

  if (typeof session.promptStreaming !== 'function') {
    const raw = await session.prompt(messages)
    return { aborted: false, raw, requestId, stale: false }
  }

  if (abortSignal?.aborted) {
    return { aborted: true, raw: '', requestId, stale: false }
  }

  const iterable = session.promptStreaming(messages)
  const chunks = await readChunks(iterable)
  const raw = mergeChunks(chunks)

  if (earlyFieldPatterns !== undefined && onEarlyField !== undefined) {
    const field = tryExtractEarlyField(raw, earlyFieldPatterns)
    if (field !== undefined) {
      onEarlyField({ name: field.name, raw, value: field.value })
    }
  }

  return {
    aborted: abortSignal?.aborted ?? false,
    raw,
    requestId,
    stale: false,
  }
}

export function tryExtractEarlyField(
  raw: string,
  patterns: Record<string, RegExp>,
): { name: string; value: unknown } | undefined {
  for (const [name, pattern] of Object.entries(patterns)) {
    const match = raw.match(pattern)
    if (match && match[1] !== undefined) {
      try {
        const value = JSON.parse(match[1])
        return { name, value }
      } catch {
        return { name, value: match[1] }
      }
    }
  }
  return undefined
}
