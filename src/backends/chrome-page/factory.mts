import { createPageOperation } from './operation.mts'
import { pagePrompt } from './prompt.mts'
import {
  pageAvailability,
  pageCloneSession,
  pageContextStatus,
  pageCreateSession,
  pageDestroySession,
} from './sessions.mts'
import { createPageStream } from './stream.mts'

import type { LanguageModelLike, SessionLike } from '../../types.mts'
import type { PageOperation } from './operation.mts'
import type { Bridge, PageErrorShape, PageLike, PageResult } from './types.mts'

export const PAGE_BRIDGE_IDS = new WeakMap<PageLike, { nextId: number }>()

export function createPageBoundFactory(bridge: Bridge): LanguageModelLike {
  const { page } = bridge
  const ids = PAGE_BRIDGE_IDS.get(page) ?? { nextId: 1 }
  PAGE_BRIDGE_IDS.set(page, ids)

  function buildSession(spec: {
    cloneCapable: boolean
    sessionId: number
  }): SessionLike {
    const { cloneCapable, sessionId } = spec
    const active = new Set<PageOperation<unknown>>()
    let destroyed = false

    function assertOpen(): void {
      if (destroyed) {
        throw new DOMException('Session destroyed', 'InvalidStateError')
      }
    }

    const session: SessionLike = {
      contextStatus() {
        assertOpen()
        return page.evaluate(pageContextStatus, { sessionId })
      },
      destroy(): void {
        if (destroyed) {
          return
        }
        destroyed = true
        for (const operation of active) {
          operation.cancel(new DOMException('Session destroyed', 'AbortError'))
        }
        active.clear()
        void page
          .evaluate(pageDestroySession, { sessionId })
          .catch(() => undefined)
      },
      async prompt(messages, options): Promise<string> {
        assertOpen()
        const opts = { __proto__: null, ...options } as typeof options
        const operationId = ids.nextId++
        const operation = createPageOperation(
          page,
          { operationId, sessionId },
          () =>
            page.evaluate<PageResult & { raw?: string | undefined }>(
              pagePrompt,
              {
                messages,
                operationId,
                responseConstraint: opts?.responseConstraint,
                sessionId,
              },
            ),
          opts?.abortSignal,
        )
        active.add(operation)
        try {
          const result = await operation.promise
          if (!result.ok || result.raw === undefined) {
            rethrowPageError(result.error)
          }
          return result.raw
        } finally {
          active.delete(operation)
        }
      },
      promptStreaming(messages, options): AsyncIterable<string> {
        assertOpen()
        const opts = { __proto__: null, ...options } as typeof options
        return createPageStream(bridge, {
          active,
          assertOpen,
          messages,
          sessionId,
          signal: opts?.abortSignal,
          streamId: ids.nextId++,
        })
      },
    }
    if (cloneCapable) {
      session.clone = async (): Promise<SessionLike> => {
        assertOpen()
        const cloneId = ids.nextId++
        const result = await page.evaluate<PageResult>(pageCloneSession, {
          cloneId,
          sessionId,
        })
        if (!result.ok) {
          rethrowPageError(result.error)
        }
        if (destroyed) {
          void page
            .evaluate(pageDestroySession, { sessionId: cloneId })
            .catch(() => undefined)
          assertOpen()
        }
        return buildSession({ cloneCapable, sessionId: cloneId })
      }
    }
    return session
  }

  return {
    contextMode: 'native',
    availability(): Promise<string> {
      return page.evaluate<string>(pageAvailability)
    },
    async create(options?: object | undefined): Promise<SessionLike> {
      const opts = { __proto__: null, ...options } as {
        abortSignal?: AbortSignal | undefined
      }
      const { abortSignal, ...nativeOptions } = opts
      const sessionId = ids.nextId++
      const invoke = async (
        operationId?: number | undefined,
      ): Promise<PageResult & { cloneCapable?: boolean | undefined }> => {
        const result = await page.evaluate<
          PageResult & { cloneCapable?: boolean | undefined }
        >(pageCreateSession, {
          operationId,
          options: stripUndefined(nativeOptions),
          sessionId,
        })
        if (abortSignal?.aborted === true) {
          void page
            .evaluate(pageDestroySession, { sessionId })
            .catch(() => undefined)
          throw abortSignal.reason
        }
        return result
      }
      const operationId = ids.nextId++
      const result =
        abortSignal === undefined
          ? await invoke()
          : await createPageOperation(
              page,
              { creating: true, operationId, sessionId },
              () => invoke(operationId),
              abortSignal,
            ).promise
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

export function rethrowPageError(error: PageErrorShape | undefined): never {
  const raised = new Error(error?.message ?? 'chrome-builtin page error')
  raised.name = error?.name ?? 'Error'
  throw raised
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
