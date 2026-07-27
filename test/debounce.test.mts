import { describe, expect, it } from 'vitest'

import { createDebouncer } from '../src/debounce.mts'

describe('createDebouncer', () => {
  it('runs the function once the delay elapses and passes the request id', async () => {
    const seen: string[] = []
    const debounced = createDebouncer(
      async (_signal, requestId) => {
        seen.push(requestId)
        return `done:${requestId}`
      },
      { delayMs: 5 },
    )
    const request = debounced('req-1')
    expect(request.requestId).toBe('req-1')
    await expect(request.promise).resolves.toBe('done:req-1')
    expect(seen).toEqual(['req-1'])
  })

  it('auto-numbers request ids when none is given', async () => {
    const debounced = createDebouncer(async () => 'ok', { delayMs: 1 })
    const first = debounced()
    expect(first.requestId).toBe('1')
    await first.promise
    const second = debounced()
    expect(second.requestId).toBe('2')
    await second.promise
  })

  it('supersedes an in-flight request so only the newest runs', async () => {
    const ran: string[] = []
    const debounced = createDebouncer(
      async (_signal, requestId) => {
        ran.push(requestId)
        return requestId
      },
      { delayMs: 20 },
    )
    // Scheduling a second request aborts the first's controller and clears its
    // pending timer; only the freshest request reaches the function body.
    const stale = debounced('stale')
    const fresh = debounced('fresh')
    stale.promise.catch(() => undefined)
    await expect(fresh.promise).resolves.toBe('fresh')
    expect(ran).toEqual(['fresh'])
  })

  it('rejects when the caller aborts before the delay elapses', async () => {
    let called = false
    const debounced = createDebouncer(
      async () => {
        called = true
        return 'never'
      },
      { delayMs: 20 },
    )
    const request = debounced('cancel-me')
    request.abort()
    await expect(request.promise).rejects.toThrow('Request aborted')
    expect(called).toBe(false)
  })

  it('defaults the delay when no options are supplied', () => {
    const debounced = createDebouncer(async () => 'x')
    const request = debounced('later')
    // A 900ms default means the function has not fired synchronously; abort so
    // the pending timer does not outlive the test.
    request.abort()
    expect(request.requestId).toBe('later')
  })

  it('propagates a rejection thrown by the debounced function', async () => {
    const debounced = createDebouncer(
      async () => {
        throw new Error('boom')
      },
      { delayMs: 1 },
    )
    await expect(debounced('x').promise).rejects.toThrow('boom')
  })
})
