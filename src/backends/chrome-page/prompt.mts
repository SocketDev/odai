import type { Message } from '../../types.mts'
import type { PageGlobalState, PageResult } from './types.mts'

export async function pagePrompt(payload: {
  messages: Message[]
  operationId?: number | undefined
  responseConstraint?: object | undefined
  sessionId: number
}): Promise<PageResult & { raw?: string | undefined }> {
  const holder = globalThis as PageGlobalState
  const session = holder.__odaiSessions?.get(payload.sessionId)
  if (session === undefined) {
    holder.__odaiOperations?.delete(payload.operationId ?? -1)
    return {
      error: { message: 'unknown session id', name: 'NotFoundError' },
      ok: false,
    }
  }
  const operation = holder.__odaiOperations?.get(payload.operationId ?? -1)
  if (payload.operationId !== undefined && operation === undefined) {
    return {
      error: { message: 'operation cancelled', name: 'AbortError' },
      ok: false,
    }
  }
  async function promptNative(): Promise<string> {
    const options: {
      responseConstraint?: object | undefined
      signal?: AbortSignal | undefined
    } = {}
    if (payload.responseConstraint !== undefined) {
      options.responseConstraint = payload.responseConstraint
    }
    const signal = operation?.controller.signal
    if (signal !== undefined) {
      options.signal = signal
      signal.throwIfAborted()
    }
    const pending =
      payload.responseConstraint === undefined && signal === undefined
        ? session!.prompt(payload.messages)
        : session!.prompt(payload.messages, options)
    if (signal === undefined) {
      return pending
    }
    return new Promise((resolve, reject) => {
      function onAbort(): void {
        signal!.removeEventListener('abort', onAbort)
        reject(signal!.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
      }
      void pending.then(
        raw => {
          signal.removeEventListener('abort', onAbort)
          resolve(raw)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }
  try {
    return { ok: true, raw: await promptNative() }
  } catch (error) {
    const err = error as Error
    return { error: { message: err.message, name: err.name }, ok: false }
  } finally {
    if (payload.operationId !== undefined) {
      holder.__odaiOperations?.delete(payload.operationId)
    }
  }
}

export async function pagePromptStreaming(payload: {
  messages: Message[]
  operationId?: number | undefined
  sessionId: number
  streamId: number
}): Promise<void> {
  const holder = globalThis as PageGlobalState
  const emit = holder.__odaiStreamChunk ?? (async () => {})
  const session = holder.__odaiSessions?.get(payload.sessionId)
  if (session === undefined) {
    holder.__odaiOperations?.delete(payload.operationId ?? -1)
    await emit({ error: 'unknown session id', streamId: payload.streamId })
    return
  }
  const operation = holder.__odaiOperations?.get(payload.operationId ?? -1)
  if (payload.operationId !== undefined && operation === undefined) {
    await emit({ error: 'operation cancelled', streamId: payload.streamId })
    return
  }
  const signal = operation?.controller.signal
  let cursor: ReturnType<typeof createCursor> | undefined
  let completed = false

  function createCursor(
    stream: AsyncIterable<string> | ReadableStream<string>,
  ) {
    let cancelled = false
    const reader = 'getReader' in stream ? stream.getReader() : undefined
    const iterator =
      reader === undefined
        ? (stream as AsyncIterable<string>)[Symbol.asyncIterator]()
        : undefined
    return {
      next(): Promise<IteratorResult<string>> {
        return reader === undefined
          ? iterator!.next()
          : (reader.read() as Promise<IteratorResult<string>>)
      },
      cancel(): void {
        if (cancelled) {
          return
        }
        cancelled = true
        void Promise.resolve(
          reader === undefined ? iterator?.return?.() : reader.cancel?.(),
        ).catch(() => undefined)
      },
      release(): void {
        reader?.releaseLock?.()
      },
    }
  }

  function readNext(
    current: ReturnType<typeof createCursor>,
  ): Promise<IteratorResult<string>> {
    if (signal === undefined) {
      return current.next()
    }
    return new Promise((resolve, reject) => {
      function onAbort(): void {
        signal!.removeEventListener('abort', onAbort)
        reject(signal!.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      void Promise.resolve()
        .then(() => current.next())
        .then(
          result => {
            signal.removeEventListener('abort', onAbort)
            resolve(result)
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        )
    })
  }

  async function pumpStream(): Promise<void> {
    try {
      signal?.throwIfAborted()
      const stream =
        signal === undefined
          ? session!.promptStreaming(payload.messages)
          : session!.promptStreaming(payload.messages, { signal })
      cursor = createCursor(stream)
      if (operation !== undefined) {
        const currentCursor = cursor
        operation.cancel = () => currentCursor.cancel()
      }
      while (true) {
        const result = await readNext(cursor)
        if (result.done) {
          completed = true
          break
        }
        await emit({ chunk: result.value, streamId: payload.streamId })
      }
      await emit({ done: true, streamId: payload.streamId })
    } catch (error) {
      await emit({
        error: (error as Error).message,
        streamId: payload.streamId,
      })
    } finally {
      if (!completed) {
        cursor?.cancel()
      }
      cursor?.release()
      if (payload.operationId !== undefined) {
        holder.__odaiOperations?.delete(payload.operationId)
      }
    }
  }
  await pumpStream()
}
