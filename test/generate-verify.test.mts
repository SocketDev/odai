import { describe, expect, it } from 'vitest'

import { generateVerified } from '../src/generate-verify.mts'
import type { TaskResult } from '../src/types.mts'

function ok(data: number): TaskResult<number> {
  return { data, ok: true, raw: String(data) }
}

function fail(error: string): TaskResult<number> {
  return { error, ok: false, raw: '' }
}

describe('generateVerified', () => {
  it('returns the first result that verifies', async () => {
    const queue: Array<TaskResult<number>> = [ok(1), ok(2), ok(3)]
    let calls = 0
    const result = await generateVerified(
      async () => {
        calls += 1
        return queue.shift()!
      },
      data => data >= 2,
      5,
    )
    expect(result).toEqual(ok(2))
    // Stops as soon as an attempt verifies rather than exhausting `attempts`.
    expect(calls).toBe(2)
  })

  it('returns the last ok result when none verifies', async () => {
    const queue: Array<TaskResult<number>> = [ok(1), fail('boom'), ok(2)]
    const result = await generateVerified(
      async () => queue.shift()!,
      () => false,
      3,
    )
    expect(result).toEqual(ok(2))
  })

  it('returns the last result when no attempt is ok', async () => {
    const queue: Array<TaskResult<number>> = [fail('a'), fail('b'), fail('c')]
    const result = await generateVerified(
      async () => queue.shift()!,
      () => true,
      3,
    )
    expect(result).toEqual(fail('c'))
  })

  it('runs a single attempt and returns it when it verifies', async () => {
    let calls = 0
    const result = await generateVerified(
      async () => {
        calls += 1
        return ok(42)
      },
      data => data === 42,
      1,
    )
    expect(result).toEqual(ok(42))
    expect(calls).toBe(1)
  })

  it('runs a single attempt and returns it even when it does not verify', async () => {
    const result = await generateVerified(
      async () => ok(7),
      () => false,
      1,
    )
    expect(result).toEqual(ok(7))
  })
})
