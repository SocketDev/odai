/**
 * @file On-device inference is free but not fast. Debounce user-driven requests
 *   and carry an AbortController so a newer request cancels the in-flight one.
 */

export interface DebouncedRequest<T> {
  abort(): void
  promise: Promise<T>
  requestId: string
}

export interface DebounceOptions {
  delayMs?: number | undefined
}

export function createDebouncer<T>(
  fn: (signal: AbortSignal, requestId: string) => Promise<T>,
  options: DebounceOptions = {},
): (requestId?: string | undefined) => DebouncedRequest<T> {
  const delayMs = options.delayMs ?? 900
  let activeController: AbortController | undefined
  let activeTimeout: ReturnType<typeof setTimeout> | undefined
  let counter = 0

  return function schedule(
    requestId?: string | undefined,
  ): DebouncedRequest<T> {
    const id = requestId ?? String((counter += 1))

    if (activeController !== undefined) {
      activeController.abort()
    }
    if (activeTimeout !== undefined) {
      clearTimeout(activeTimeout)
    }

    const controller = new AbortController()
    activeController = controller

    const promise = new Promise<T>((resolve, reject) => {
      activeTimeout = setTimeout(() => {
        activeTimeout = undefined
        if (controller.signal.aborted) {
          reject(new Error('Request aborted'))
          return
        }
        fn(controller.signal, id).then(resolve).catch(reject)
      }, delayMs)
    })

    return {
      abort(): void {
        controller.abort()
      },
      promise,
      requestId: id,
    }
  }
}
