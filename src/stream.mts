/**
 * @file Streaming inference with on-device models is slow; act on the first
 *   parseable field. This module normalizes cumulative vs delta chunks and
 *   wires abort + stale-response tags.
 */

import type { Message, SessionLike } from './types.mts'

export const STREAM_ABORTED = Symbol('Stream aborted')

export interface StreamOptions {
  abortSignal?: AbortSignal | undefined
  onEarlyField?:
    | ((field: { name: string; raw: string; value: unknown }) => void)
    | undefined
  /**
   * Map of field name → regex that extracts a JSON-like value as soon as it is
   * complete. The regex should capture the value in group 1.
   */
  // oxlint-disable-next-line socket/prefer-refined-record -- open key set
  earlyFieldPatterns?: Record<string, RegExp> | undefined
  requestId?: string | undefined
}

export interface StreamResult {
  aborted: boolean
  raw: string
  requestId?: string | undefined
  stale: boolean
}

export type StreamChunk =
  | { done: true }
  | { done?: false | undefined; value: string }

export interface StreamReader {
  cancel(reason: unknown): unknown
  next(): Promise<StreamChunk>
  release(): void
}

export type StreamValue<T> = T | typeof STREAM_ABORTED

export function awaitStreamValue<T>(
  pending: Promise<T>,
  signal?: AbortSignal | undefined,
): Promise<StreamValue<T>> {
  if (signal === undefined) {
    return pending
  }
  const abortSignal = signal
  return new Promise((resolve, reject) => {
    function abort(): void {
      abortSignal.removeEventListener('abort', abort)
      resolve(STREAM_ABORTED)
    }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) {
      abort()
    }
  })
}

export function cancelStreamReader(
  reader: StreamReader,
  reason: unknown,
): void {
  try {
    // A provider may wait for generation before it acknowledges cancellation.
    void Promise.resolve(reader.cancel(reason)).catch(() => undefined)
  } catch {
    /* Cleanup must not replace the prompt's result or error. */
  }
}

export async function consumeStream(
  iterable: AsyncIterable<string> | ReadableStream<string>,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal | undefined,
): Promise<boolean> {
  const reader = createStreamReader(iterable)
  let completed = false
  try {
    while (!signal?.aborted) {
      const result = await awaitStreamValue(reader.next(), signal)
      if (result === STREAM_ABORTED || signal?.aborted) {
        return true
      }
      if (result.done) {
        completed = true
        return false
      }
      onChunk(result.value)
    }
    return true
  } finally {
    if (!completed) {
      cancelStreamReader(reader, signal?.reason)
    }
    reader.release()
  }
}

export function createStreamReader(
  iterable: AsyncIterable<string> | ReadableStream<string>,
): StreamReader {
  if (isReadableStream(iterable)) {
    const reader = iterable.getReader()
    return {
      cancel: reason => reader.cancel(reason),
      next: () => reader.read(),
      release: () => reader.releaseLock(),
    }
  }
  const iterator = iterable[Symbol.asyncIterator]()
  return {
    cancel: () => iterator.return?.(),
    next: () => iterator.next(),
    release() {},
  }
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
    raw = mergeStreamChunk(raw, chunks[i]!)
  }
  return raw
}

export function mergeStreamChunk(raw: string, chunk: string): string {
  return chunk.length > raw.length && chunk.startsWith(raw)
    ? chunk
    : raw + chunk
}

export async function readChunks(
  iterable: AsyncIterable<string> | ReadableStream<string>,
): Promise<string[]> {
  const chunks: string[] = []
  await consumeStream(iterable, chunk => chunks.push(chunk))
  return chunks
}

export async function streamPrompt(
  session: SessionLike,
  messages: Message[],
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { abortSignal, onEarlyField, earlyFieldPatterns, requestId } = options

  if (abortSignal?.aborted) {
    return { aborted: true, raw: '', requestId, stale: false }
  }

  if (typeof session.promptStreaming !== 'function') {
    const result = await awaitStreamValue(
      session.prompt(messages, { abortSignal }),
      abortSignal,
    )
    if (result === STREAM_ABORTED || abortSignal?.aborted) {
      return { aborted: true, raw: '', requestId, stale: false }
    }
    return {
      aborted: false,
      raw: result,
      requestId,
      stale: false,
    }
  }

  const iterable = session.promptStreaming(messages, { abortSignal })
  let raw = ''
  let reportedField = false
  const aborted = await consumeStream(
    iterable,
    chunk => {
      raw = mergeStreamChunk(raw, chunk)
      if (
        !reportedField &&
        earlyFieldPatterns !== undefined &&
        onEarlyField !== undefined
      ) {
        const field = tryExtractEarlyField(raw, earlyFieldPatterns)
        if (field !== undefined) {
          reportedField = true
          onEarlyField({ name: field.name, raw, value: field.value })
        }
      }
    },
    abortSignal,
  )

  return {
    aborted,
    raw,
    requestId,
    stale: false,
  }
}

export function tryExtractEarlyField(
  raw: string,
  // oxlint-disable-next-line socket/prefer-refined-record -- open key set
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
