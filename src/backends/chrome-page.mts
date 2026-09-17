/**
 * @file Chrome page bridge and model readiness polling.
 */

import { pageAvailability, pageKickDownload } from './chrome-page/sessions.mts'

import type {
  PageLike,
  WaitForModelReadyOptions,
} from './chrome-page/types.mts'

export {
  createPageBoundFactory,
  rethrowPageError,
  stripUndefined,
} from './chrome-page/factory.mts'
export { pagePrompt, pagePromptStreaming } from './chrome-page/prompt.mts'
export { StreamQueue } from './chrome-page/queue.mts'
export {
  pageAvailability,
  pageCloneSession,
  pageContextStatus,
  pageCreateSession,
  pageDestroySession,
  pageKickDownload,
} from './chrome-page/sessions.mts'
export type {
  Bridge,
  BrowserContextLike,
  ChromiumLauncherLike,
  PageErrorShape,
  PageLike,
  StreamPayload,
  WaitForModelReadyOptions,
} from './chrome-page/types.mts'

export const STREAM_BINDING_NAME = '__odaiStreamChunk'
export const DEFAULT_READY_TIMEOUT_MS = 120_000
export const DOWNLOAD_KICK_GRACE_MS = 10_000
export const DOWNLOAD_READY_TIMEOUT_MS = 1_800_000
export const READY_POLL_INTERVAL_MS = 2000

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
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
    await new Promise(resolve =>
      setTimeout(resolve, Math.min(READY_POLL_INTERVAL_MS, remainingMs)),
    )
  }
  throw new Error(
    `the on-device model did not become available within ${timeoutMs}ms (last ` +
      `state "${state}"). First activation of a fresh bridge profile needs ` +
      'network for one keyless component-metadata exchange; once activated the ' +
      `profile at ${opts.userDataDir} works offline.`,
  )
}
