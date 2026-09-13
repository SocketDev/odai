import type { PageGlobalState, PageResult } from './types.mts'

// Page functions use only their arguments and globals because Playwright serializes them.
export function pageBeginOperation(payload: {
  creating?: boolean | undefined
  operationId: number
  sessionId: number
}): PageResult {
  const holder = globalThis as PageGlobalState
  if (
    payload.creating !== true &&
    !holder.__odaiSessions?.has(payload.sessionId)
  ) {
    return {
      error: { message: 'unknown session id', name: 'NotFoundError' },
      ok: false,
    }
  }
  holder.__odaiOperations ??= new Map()
  holder.__odaiOperations.set(payload.operationId, {
    controller: new AbortController(),
    sessionId: payload.sessionId,
  })
  return { ok: true }
}

export function pageCancelOperation(payload: { operationId: number }): void {
  const holder = globalThis as PageGlobalState
  const operation = holder.__odaiOperations?.get(payload.operationId)
  holder.__odaiOperations?.delete(payload.operationId)
  operation?.controller.abort()
  operation?.cancel?.()
}
