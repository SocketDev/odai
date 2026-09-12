export function awaitCancellable<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  disposeLate?: ((value: T) => void) | undefined,
): Promise<T> {
  if (signal === undefined) {
    return pending
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const abort = (): void => {
      if (settled) {
        return
      }
      settled = true
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
    pending.then(
      value => {
        signal.removeEventListener('abort', abort)
        if (settled) {
          try {
            disposeLate?.(value)
          } catch {
            /* Resource is already cancelled. */
          }
          return
        }
        settled = true
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        if (!settled) {
          settled = true
          reject(error)
        }
      },
    )
  })
}
