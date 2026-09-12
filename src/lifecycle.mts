import { awaitCancellable } from './cancellation.mts'
import { createOdaiModel, destroySession } from './model.mts'
import type { OdaiModel } from './model.mts'
import type { BackendName } from './backends/types.mts'

export interface OdaiOperationContext {
  abortSignal: AbortSignal
}

export interface OdaiOperationOptions {
  abortSignal?: AbortSignal | undefined
  backend?: BackendName | undefined
  timeoutMs?: number | undefined
}

export async function withOdaiModel<T>(
  callback: (model: OdaiModel, context: OdaiOperationContext) => Promise<T>,
  options: OdaiOperationOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) {
    throw new RangeError(
      'Interactive inference budget must be between 100 and 5000 milliseconds.',
    )
  }
  options.abortSignal?.throwIfAborted()
  const controller = new AbortController()
  const signal =
    options.abortSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.abortSignal])
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          'Interactive inference deadline exceeded',
          'TimeoutError',
        ),
      ),
    timeoutMs - Math.min(250, timeoutMs / 10),
  )
  let model: OdaiModel | undefined
  try {
    model = await createOdaiModel({
      abortSignal: signal,
      backend: options.backend,
      interactive: true,
    })
    signal.throwIfAborted()
    return await awaitCancellable(
      callback(model, { abortSignal: signal }),
      signal,
    )
  } finally {
    controller.abort(
      new DOMException('Interactive inference finished', 'AbortError'),
    )
    clearTimeout(timer)
    if (model !== undefined) {
      destroySession(model.rawSession())
    }
  }
}
