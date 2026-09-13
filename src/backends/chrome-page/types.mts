import type { NativeChromeSession } from '../chrome-native.mts'
import type { SessionContextStatus } from '../../types.mts'
import type { StreamQueue } from './queue.mts'

export interface Bridge {
  close(): Promise<void>
  page: PageLike
  streams: Map<number, StreamQueue>
}

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

export interface PageResult {
  error?: PageErrorShape | undefined
  ok: boolean
}

export interface PageOperationState {
  cancel?: (() => void) | undefined
  controller: AbortController
  sessionId: number
}

export interface PageSessionContext {
  listener: () => void
  status: SessionContextStatus
}

export interface PageGlobalState {
  __odaiContexts?: Map<number, PageSessionContext> | undefined
  __odaiOperations?: Map<number, PageOperationState> | undefined
  __odaiSessions?: Map<number, NativeChromeSession> | undefined
  __odaiStreamChunk?: ((payload: StreamPayload) => Promise<unknown>) | undefined
}

export interface StreamPayload {
  chunk?: string | undefined
  done?: boolean | undefined
  error?: string | undefined
  streamId: number
}

export interface WaitForModelReadyOptions {
  // oxlint-disable-next-line socket/no-required-in-options-bag -- public API
  allowDownload: boolean
  readyTimeoutMs?: number | undefined
  // oxlint-disable-next-line socket/no-required-in-options-bag -- public API
  userDataDir: string
}
