/**
 * @file Generate-and-verify reliability loop for code-generation tasks. A small
 *   on-device model produces a well-formed answer only some of the time, so
 *   re-running the same task and keeping the first output that passes a general
 *   oracle collapses that variance. Unlike best-of-N (majority vote over a
 *   discrete key) this returns as soon as one attempt verifies, and otherwise
 *   falls back to the last ok result — a plausible-but-unverified answer beats
 *   a hard failure.
 */

import type { TaskResult } from './types.mts'

/**
 * Run `run` up to `attempts` times and return the first result that is `ok`,
 * carries `data`, and passes `verify`. When none verifies, return the last `ok`
 * result if any attempt produced one, otherwise the last result seen.
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
  let lastOk: TaskResult<T> | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Attempts are intentionally sequential: each re-ask gets a fresh clone
    // inside the model wrapper, and a stateful backend rejects overlapping use.
    // oxlint-disable-next-line no-await-in-loop -- verify-loop attempts are intentionally sequential
    const result = await run()
    last = result
    if (result.ok && result.data !== undefined) {
      lastOk = result
      if (verify(result.data)) {
        return result
      }
    }
  }
  return lastOk ?? last
}
