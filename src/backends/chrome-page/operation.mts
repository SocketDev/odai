import { pageBeginOperation, pageCancelOperation } from './operations.mts'

import type { PageLike, PageResult } from './types.mts'

export interface PageOperation<T> {
  cancel(reason: unknown): void
  promise: Promise<T>
}

export interface PageOperationSpec {
  creating?: boolean | undefined
  operationId: number
  sessionId: number
}

export function createPageOperation<T>(
  page: PageLike,
  spec: PageOperationSpec,
  invoke: () => Promise<T>,
  signal?: AbortSignal | undefined,
): PageOperation<T> {
  let settled = false
  let begin: Promise<PageResult> | undefined
  let rejectOperation: (reason: unknown) => void = () => {}
  const onAbort = (): void => {
    cancel(signal?.reason)
  }

  function finish(): void {
    settled = true
    signal?.removeEventListener('abort', onAbort)
  }

  function cancel(reason: unknown): void {
    if (settled) {
      return
    }
    finish()
    rejectOperation(reason)
    // Registration completes before cancellation so an early abort cannot miss its controller.
    void begin
      ?.then(() =>
        page.evaluate(pageCancelOperation, {
          operationId: spec.operationId,
        }),
      )
      .catch(() => undefined)
  }

  const promise = new Promise<T>((resolve, reject) => {
    rejectOperation = reject
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) {
      cancel(signal.reason)
      return
    }
    begin = page.evaluate<PageResult>(pageBeginOperation, spec)
    void begin
      .then(async result => {
        if (settled) {
          return
        }
        if (!result.ok) {
          const error = new Error(
            result.error?.message ?? 'Chrome operation failed',
          )
          error.name = result.error?.name ?? 'Error'
          throw error
        }
        const value = await invoke()
        if (!settled) {
          finish()
          resolve(value)
        }
      })
      .catch((error: unknown) => {
        if (!settled) {
          finish()
          reject(error)
        }
        void page
          .evaluate(pageCancelOperation, { operationId: spec.operationId })
          .catch(() => undefined)
      })
  })
  return { cancel, promise }
}
