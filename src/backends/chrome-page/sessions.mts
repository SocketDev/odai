import type {
  NativeChromeFactory,
  NativeChromeSession,
} from '../chrome/native.mts'
import type { SessionContextStatus } from '../../types.mts'
import type { PageGlobalState, PageResult } from './types.mts'

export function pageAvailability(): Promise<string> | string {
  const model = (
    globalThis as { LanguageModel?: NativeChromeFactory | undefined }
  ).LanguageModel
  if (model === undefined) {
    return 'no-global'
  }
  return model.availability() as Promise<string> | string
}

export async function pageCloneSession(payload: {
  cloneId: number
  sessionId: number
}): Promise<PageResult> {
  const holder = globalThis as PageGlobalState
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
  const context = holder.__odaiContexts?.get(payload.sessionId)
  try {
    const clone = await session.clone()
    if (store.get(payload.sessionId) !== session) {
      clone.destroy?.()
      throw new DOMException('Source session destroyed', 'InvalidStateError')
    }
    const status = { overflowed: context?.status.overflowed === true }
    const listener = (): void => {
      status.overflowed = true
    }
    clone.addEventListener?.('contextoverflow', listener)
    holder.__odaiContexts ??= new Map()
    holder.__odaiContexts.set(payload.cloneId, { listener, status })
    store.set(payload.cloneId, clone)
    return { ok: true }
  } catch (error) {
    const err = error as Error
    return { error: { message: err.message, name: err.name }, ok: false }
  }
}

export function pageContextStatus(payload: {
  sessionId: number
}): SessionContextStatus {
  const holder = globalThis as PageGlobalState
  const session = holder.__odaiSessions?.get(payload.sessionId)
  if (session === undefined) {
    throw new DOMException('unknown session id', 'NotFoundError')
  }
  return {
    contextUsage: session.contextUsage,
    contextWindow: session.contextWindow,
    overflowed:
      holder.__odaiContexts?.get(payload.sessionId)?.status.overflowed === true,
  }
}

export async function pageCreateSession(payload: {
  operationId?: number | undefined
  options: object
  sessionId: number
}): Promise<PageResult & { cloneCapable?: boolean | undefined }> {
  const holder = globalThis as PageGlobalState
  const operationId = payload.operationId ?? -1
  const model = (
    globalThis as { LanguageModel?: NativeChromeFactory | undefined }
  ).LanguageModel
  if (model === undefined) {
    holder.__odaiOperations?.delete(operationId)
    return {
      error: { message: 'LanguageModel global missing', name: 'Error' },
      ok: false,
    }
  }
  const operation = holder.__odaiOperations?.get(operationId)
  if (payload.operationId !== undefined && operation === undefined) {
    return {
      error: { message: 'operation cancelled', name: 'AbortError' },
      ok: false,
    }
  }
  holder.__odaiSessions ??= new Map()
  function captureSession(session: NativeChromeSession): void {
    const status = { overflowed: false }
    const listener = (): void => {
      status.overflowed = true
    }
    session.addEventListener?.('contextoverflow', listener)
    holder.__odaiContexts ??= new Map()
    holder.__odaiContexts.set(payload.sessionId, { listener, status })
    holder.__odaiSessions!.set(payload.sessionId, session)
  }
  try {
    const options =
      operation === undefined
        ? payload.options
        : { ...payload.options, signal: operation.controller.signal }
    const session = await model.create(options)
    if (operation?.controller.signal.aborted === true) {
      session.destroy?.()
      throw operation.controller.signal.reason
    }
    captureSession(session)
    return { cloneCapable: typeof session.clone === 'function', ok: true }
  } catch (error) {
    const err = error as Error
    return { error: { message: err.message, name: err.name }, ok: false }
  } finally {
    if (payload.operationId !== undefined) {
      holder.__odaiOperations?.delete(payload.operationId)
    }
  }
}

export function pageDestroySession(payload: { sessionId: number }): void {
  const holder = globalThis as PageGlobalState
  const session = holder.__odaiSessions?.get(payload.sessionId)
  const context = holder.__odaiContexts?.get(payload.sessionId)
  holder.__odaiContexts?.delete(payload.sessionId)
  holder.__odaiSessions?.delete(payload.sessionId)
  if (context !== undefined) {
    session?.removeEventListener?.('contextoverflow', context.listener)
  }
  for (const [operationId, operation] of holder.__odaiOperations ?? []) {
    if (operation.sessionId === payload.sessionId) {
      holder.__odaiOperations?.delete(operationId)
      operation.controller.abort()
      operation.cancel?.()
    }
  }
  session?.destroy?.()
}

export async function pageKickDownload(): Promise<string> {
  const model = (
    globalThis as { LanguageModel?: NativeChromeFactory | undefined }
  ).LanguageModel
  if (model === undefined) {
    return 'no-global'
  }
  try {
    const session = await model.create({})
    session.destroy?.()
    return 'created'
  } catch (error) {
    return `create failed: ${(error as Error).message}`
  }
}
