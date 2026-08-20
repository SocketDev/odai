/**
 * @file Page-proxy layer for the chrome-builtin bridge. The `page*`
 *   functions run INSIDE Chrome via `page.evaluate`: playwright serializes
 *   them into the page, so they must be self-contained — argument plus
 *   globals only, no closure over Node scope. `createPageBoundFactory` wraps
 *   them into odai's `LanguageModelLike` shape; streaming chunks flow
 *   back over an exposed binding into per-stream queues.
 */

import type { LanguageModelLike, Message, SessionLike } from '../types.mts'

export const STREAM_BINDING_NAME = '__odaiStreamChunk'

const DEFAULT_READY_TIMEOUT_MS = 120_000
const DOWNLOAD_KICK_GRACE_MS = 10_000
const DOWNLOAD_READY_TIMEOUT_MS = 1_800_000
const READY_POLL_INTERVAL_MS = 2000

export interface Bridge {
  close(): Promise<void>
  page: PageLike
  streams: Map<number, StreamQueue>
}

/**
 * The slice of playwright's browser context the bridge drives — structurally
 * typed so playwright-core stays a lazy optional dependency and tests can
 * fake the boundary.
 */
export interface BrowserContextLike {
  close(): Promise<void>
  newPage(): Promise<PageLike>
}

export interface ChromiumLauncherLike {
  launchPersistentContext(
    userDataDir: string,
    options: object,
  ): Promise<BrowserContextLike>
}

export interface PageErrorShape {
  message: string
  name: string
}

export interface PageLike {
  evaluate<T>(fn: unknown, arg?: unknown | undefined): Promise<T>
  exposeFunction(
    name: string,
    callback: (arg: never) => unknown,
  ): Promise<unknown>
  goto(url: string): Promise<unknown>
}

export interface StreamPayload {
  chunk?: string | undefined
  done?: boolean | undefined
  error?: string | undefined
  streamId: number
}

// Published API shape; renaming the exported interface or reshaping the
// bag is a breaking change.
export interface WaitForModelReadyOptions {
  // oxlint-disable-next-line socket/no-required-in-options-bag -- public API
  allowDownload: boolean
  readyTimeoutMs?: number | undefined
  // oxlint-disable-next-line socket/no-required-in-options-bag -- public API
  userDataDir: string
}

export function createPageBoundFactory(bridge: Bridge): LanguageModelLike {
  let nextId = 1
  const { page, streams } = bridge

  function buildSession(spec: {
    cloneCapable: boolean
    sessionId: number
  }): SessionLike {
    const { cloneCapable, sessionId } = spec
    // clone() is only advertised when the page session really has one, so
    // the model wrapper's cloneCapable detection stays truthful.
    const cloneMethods = cloneCapable
      ? {
          async clone(): Promise<SessionLike> {
            const cloneId = nextId++
            const result = await page.evaluate<{
              error?: PageErrorShape | undefined
              ok: boolean
            }>(pageCloneSession, { cloneId, sessionId })
            if (!result.ok) {
              rethrowPageError(result.error)
            }
            return buildSession({ cloneCapable, sessionId: cloneId })
          },
        }
      : {}
    return {
      ...cloneMethods,
      destroy(): void {
        void page
          .evaluate(pageDestroySession, { sessionId })
          .catch(() => undefined)
      },
      async prompt(
        messages: Message[],
        options?: { responseConstraint?: object | undefined } | undefined,
      ): Promise<string> {
        const opts = { __proto__: null, ...options } as typeof options
        const result = await page.evaluate<{
          error?: PageErrorShape | undefined
          ok: boolean
          raw?: string | undefined
        }>(pagePrompt, {
          messages,
          responseConstraint: opts?.responseConstraint,
          sessionId,
        })
        if (!result.ok || result.raw === undefined) {
          rethrowPageError(result.error)
        }
        return result.raw
      },
      promptStreaming(messages: Message[]): AsyncIterable<string> {
        const streamId = nextId++
        const queue = new StreamQueue()
        streams.set(streamId, queue)
        const pump = page
          .evaluate(pagePromptStreaming, { messages, sessionId, streamId })
          .catch((error: unknown) => {
            queue.push({
              error: (error as Error).message,
              streamId,
            })
          })
        return (async function* generate(): AsyncGenerator<string> {
          try {
            while (true) {
              const payload = await queue.next()
              if (payload.error !== undefined) {
                throw new Error(payload.error)
              }
              if (payload.done === true) {
                return
              }
              if (payload.chunk !== undefined) {
                yield payload.chunk
              }
            }
          } finally {
            streams.delete(streamId)
            await pump
          }
        })()
      },
    }
  }

  return {
    availability(): Promise<string> {
      return page.evaluate<string>(pageAvailability)
    },
    async create(options?: object | undefined): Promise<SessionLike> {
      const sessionId = nextId++
      const result = await page.evaluate<{
        cloneCapable?: boolean | undefined
        error?: PageErrorShape | undefined
        ok: boolean
      }>(pageCreateSession, {
        options: stripUndefined(options ?? {}),
        sessionId,
      })
      if (!result.ok) {
        rethrowPageError(result.error)
      }
      return buildSession({
        cloneCapable: result.cloneCapable === true,
        sessionId,
      })
    },
  }
}

export function pageAvailability(): Promise<string> | string {
  const model = (
    globalThis as { LanguageModel?: LanguageModelLike | undefined }
  ).LanguageModel
  if (model === undefined) {
    return 'no-global'
  }
  return model.availability() as Promise<string> | string
}

export async function pageCloneSession(payload: {
  cloneId: number
  sessionId: number
}): Promise<{ error?: PageErrorShape | undefined; ok: boolean }> {
  const holder = globalThis as {
    __odaiSessions?:
      | Map<number, { clone?: (() => unknown) | undefined }>
      | undefined
  }
  const store = holder.__odaiSessions
  const session = store?.get(payload.sessionId)
  if (store === undefined || session === undefined) {
    return {
      error: { message: 'unknown session id', name: 'NotFoundError' },
      ok: false,
    }
  }
  if (typeof session.clone !== 'function') {
    return {
      error: { message: 'session has no clone()', name: 'NotSupportedError' },
      ok: false,
    }
  }
  try {
    const clone = await session.clone()
    store.set(payload.cloneId, clone as never)
    return { ok: true }
  } catch (error) {
    const err = error as Error
    return { error: { message: err.message, name: err.name }, ok: false }
  }
}

export async function pageCreateSession(payload: {
  options: object
  sessionId: number
}): Promise<{
  cloneCapable?: boolean | undefined
  error?: PageErrorShape | undefined
  ok: boolean
}> {
  const model = (
    globalThis as { LanguageModel?: LanguageModelLike | undefined }
  ).LanguageModel
  if (model === undefined) {
    return {
      error: { message: 'LanguageModel global missing', name: 'Error' },
      ok: false,
    }
  }
  const holder = globalThis as {
    __odaiSessions?: Map<number, unknown> | undefined
  }
  holder.__odaiSessions ??= new Map()
  const store = holder.__odaiSessions
  try {
    const session = await model.create(payload.options)
    store.set(payload.sessionId, session)
    return {
      cloneCapable:
        typeof (session as { clone?: unknown | undefined }).clone ===
        'function',
      ok: true,
    }
  } catch (error) {
    const err = error as Error
    return { error: { message: err.message, name: err.name }, ok: false }
  }
}

export function pageDestroySession(payload: { sessionId: number }): void {
  const holder = globalThis as {
    __odaiSessions?:
      | Map<number, { destroy?: (() => void) | undefined }>
      | undefined
  }
  const session = holder.__odaiSessions?.get(payload.sessionId)
  if (session !== undefined) {
    session.destroy?.()
    holder.__odaiSessions?.delete(payload.sessionId)
  }
}

export async function pageKickDownload(): Promise<string> {
  const model = (
    globalThis as { LanguageModel?: LanguageModelLike | undefined }
  ).LanguageModel
  if (model === undefined) {
    return 'no-global'
  }
  try {
    const session = await model.create({})
    ;(session as { destroy?: (() => void) | undefined }).destroy?.()
    return 'created'
  } catch (error) {
    return `create failed: ${(error as Error).message}`
  }
}

export async function pagePrompt(payload: {
  messages: Message[]
  responseConstraint?: object | undefined
  sessionId: number
}): Promise<{
  error?: PageErrorShape | undefined
  ok: boolean
  raw?: string | undefined
}> {
  const holder = globalThis as {
    __odaiSessions?:
      | Map<
          number,
          {
            prompt(
              messages: unknown,
              options?: unknown | undefined,
            ): Promise<string>
          }
        >
      | undefined
  }
  const session = holder.__odaiSessions?.get(payload.sessionId)
  if (session === undefined) {
    return {
      error: { message: 'unknown session id', name: 'NotFoundError' },
      ok: false,
    }
  }
  try {
    // Runtime feature-detection against the live Nano session: pass
    // responseConstraint only when the caller supplied one, and if this Chrome
    // build rejects the option (throws) fall back to a plain prompt so an older
    // runtime never hard-fails.
    if (payload.responseConstraint !== undefined) {
      try {
        return {
          ok: true,
          raw: await session.prompt(payload.messages, {
            responseConstraint: payload.responseConstraint,
          }),
        }
      } catch {
        // Unsupported option or a throw — fall through to the plain prompt.
      }
    }
    return { ok: true, raw: await session.prompt(payload.messages) }
  } catch (error) {
    const err = error as Error
    return { error: { message: err.message, name: err.name }, ok: false }
  }
}

export async function pagePromptStreaming(payload: {
  messages: Message[]
  sessionId: number
  streamId: number
}): Promise<void> {
  const holder = globalThis as {
    __odaiSessions?:
      | Map<number, { promptStreaming(messages: unknown): unknown }>
      | undefined
    __odaiStreamChunk?: ((chunk: object) => Promise<unknown>) | undefined
  }
  const emit =
    holder.__odaiStreamChunk ??
    (async () => {
      /* binding not installed; nothing to deliver to */
    })
  const session = holder.__odaiSessions?.get(payload.sessionId)
  if (session === undefined) {
    await emit({ error: 'unknown session id', streamId: payload.streamId })
    return
  }
  try {
    const stream = session.promptStreaming(payload.messages) as
      | AsyncIterable<string>
      | ReadableStream<string>
    if (Symbol.asyncIterator in stream) {
      for await (const chunk of stream as AsyncIterable<string>) {
        await emit({ chunk, streamId: payload.streamId })
      }
    } else {
      const reader = (stream as ReadableStream<string>).getReader()
      while (true) {
        const result = await reader.read()
        if (result.done) {
          break
        }
        await emit({ chunk: result.value, streamId: payload.streamId })
      }
    }
    await emit({ done: true, streamId: payload.streamId })
  } catch (error) {
    await emit({
      error: (error as Error).message,
      streamId: payload.streamId,
    })
  }
}

export function rethrowPageError(error: PageErrorShape | undefined): never {
  const raised = new Error(error?.message ?? 'chrome-builtin page error')
  raised.name = error?.name ?? 'Error'
  throw raised
}

export class StreamQueue {
  private readonly buffered: StreamPayload[] = []
  private notify: (() => void) | undefined

  async next(): Promise<StreamPayload> {
    while (this.buffered.length === 0) {
      await new Promise<void>(resolve => {
        this.notify = resolve
      })
    }
    // Length checked above; shift() cannot return undefined here.
    return this.buffered.shift()!
  }

  push(payload: StreamPayload): void {
    this.buffered.push(payload)
    this.notify?.()
    this.notify = undefined
  }
}

export function stripUndefined(options: object): object {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      cleaned[key] = value
    }
  }
  return cleaned
}

export async function waitForModelReady(
  page: PageLike,
  options: WaitForModelReadyOptions,
): Promise<void> {
  const opts = { __proto__: null, ...options } as WaitForModelReadyOptions
  const timeoutMs =
    opts.readyTimeoutMs ??
    (opts.allowDownload ? DOWNLOAD_READY_TIMEOUT_MS : DEFAULT_READY_TIMEOUT_MS)
  const startedAt = Date.now()
  let kicked = false
  let state = ''
  while (Date.now() - startedAt < timeoutMs) {
    state = await page.evaluate<string>(pageAvailability)
    if (state === 'available') {
      return
    }
    if (state === 'no-global') {
      throw new Error(
        'Chrome exposed no LanguageModel global on the bridge page. This ' +
          'needs real Google Chrome — Chromium builds cannot run the ' +
          'on-device model — new enough to ship the Prompt API.',
      )
    }
    const kickDue =
      opts.allowDownload || Date.now() - startedAt > DOWNLOAD_KICK_GRACE_MS
    if (state === 'downloadable' && kickDue && !kicked) {
      kicked = true
      // Fire-and-forget: create() is what moves Chrome from downloadable to
      // downloading/available; its session is destroyed on arrival.
      void page.evaluate<string>(pageKickDownload).catch(() => undefined)
    }
    await new Promise(resolve => setTimeout(resolve, READY_POLL_INTERVAL_MS))
  }
  throw new Error(
    `the on-device model did not become available within ${timeoutMs}ms (last ` +
      `state "${state}"). First activation of a fresh bridge profile needs ` +
      'network for one keyless component-metadata exchange; once activated the ' +
      `profile at ${opts.userDataDir} works offline.`,
  )
}
