/**
 * @file Generate-and-verify reliability loop for code-generation tasks. A small
 *   on-device model produces a well-formed answer only some of the time, so
 *   re-running the same task and keeping the first output that passes a general
 *   oracle collapses that variance. Unlike best-of-N (majority vote over a
 *   discrete key) this returns as soon as one attempt verifies. Exhausted
 *   attempts report failure and preserve the last response for diagnostics.
 */

import type { TaskResult } from './types.mts'

/**
 * Run `run` up to `attempts` times and return the first result that is `ok`,
 * carries `data`, and passes `verify`. Rejected candidates never become a
 * successful result merely because the attempt budget is exhausted.
 */
export async function generateVerified<T>(
  run: () => Promise<TaskResult<T>>,
  verify: (data: T) => boolean,
  attempts: number,
): Promise<TaskResult<T>> {
  let last: TaskResult<T> = {
    error: 'model produced no result',
    ok: false,
    raw: '',
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Attempts are intentionally sequential: each re-ask gets a fresh clone
    // inside the model wrapper, and a stateful backend rejects overlapping use.
    // oxlint-disable-next-line no-await-in-loop -- sequential attempts
    const result = await run()
    last = result
    if (result.ok && result.data !== undefined) {
      if (verify(result.data)) {
        return result
      }
      last = {
        error: 'model result failed verification',
        model: result.model,
        ok: false,
        raw: result.raw,
      }
    } else if (result.ok) {
      last = {
        error: 'model result has no data to verify',
        model: result.model,
        ok: false,
        raw: result.raw,
      }
    }
  }
  return last
}
