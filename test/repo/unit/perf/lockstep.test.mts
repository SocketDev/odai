import { describe, expect, it, vi } from 'vitest'
import {
  LOCKSTEP_CONTEXT_PREFIX,
  lockstepExperimentOrder,
  parseLockstepExperimentArgs,
  stripLockstepPrefix,
  traceLockstepSession,
} from '../../../../scripts/repo/perf/lockstep.mts'
import type { LockstepAttempt } from '../../../../scripts/repo/perf/lockstep.mts'
import type { SessionLike } from '../../../../src/types.mts'

function sessionFixture() {
  const session = {
    clone: vi.fn(async (): Promise<SessionLike> => sessionFixture()),
    destroy: vi.fn(),
    prompt: vi.fn(async () => 'answer'),
    async *promptStreaming() {
      yield 'answer'
    },
  }
  return session
}

describe('lockstep context experiment', () => {
  it.each(
    [[], ['--pairs', '3'], ['--pairs', '20', '--timeout', '10']].map(args => ({
      args,
    })),
  )('accepts bounded options', ({ args }) => {
    const options = parseLockstepExperimentArgs(args)
    expect(options.pairs).toBeGreaterThanOrEqual(1)
    expect(options.pairs).toBeLessThanOrEqual(20)
  })

  it.each(
    [
      ['--pairs', '0'],
      ['--pairs', '21'],
      ['--pairs', '1.5'],
      ['--timeout', '0'],
      ['--timeout', 'Infinity'],
      ['--unknown'],
      ['--mode', 'unknown'],
    ].map(args => ({ args })),
  )('rejects invalid options', ({ args }) => {
    expect(() => parseLockstepExperimentArgs(args)).toThrow()
  })

  it('strips exactly one matching template and preserves caller data', () => {
    const input = { role: 'user' as const, content: 'evidence' }
    const messages = [...LOCKSTEP_CONTEXT_PREFIX, input]
    expect(stripLockstepPrefix(messages)).toEqual([input])
    expect(messages).toHaveLength(LOCKSTEP_CONTEXT_PREFIX.length + 1)
    expect(() => stripLockstepPrefix([input])).toThrow()
    expect(() =>
      stripLockstepPrefix([
        { role: 'user', content: LOCKSTEP_CONTEXT_PREFIX[0]!.content },
        ...messages.slice(1),
      ]),
    ).toThrow()
  })

  it('balances both mode and materialization order across pairs', () => {
    expect(lockstepExperimentOrder(0, 'both')).toEqual([
      { mode: 'per-request', materializations: ['full', 'sparse'] },
      { mode: 'preloaded', materializations: ['full', 'sparse'] },
    ])
    expect(lockstepExperimentOrder(1, 'both')).toEqual([
      { mode: 'preloaded', materializations: ['sparse', 'full'] },
      { mode: 'per-request', materializations: ['sparse', 'full'] },
    ])
  })

  it('evaluates production context by default and keeps experiments explicit', () => {
    expect(parseLockstepExperimentArgs([]).mode).toBe('per-request')
    expect(lockstepExperimentOrder(0)).toEqual([
      { mode: 'per-request', materializations: ['full', 'sparse'] },
    ])
    expect(lockstepExperimentOrder(1, 'preloaded')).toEqual([
      { mode: 'preloaded', materializations: ['sparse', 'full'] },
    ])
    expect(parseLockstepExperimentArgs(['--mode', 'both']).mode).toBe('both')
  })

  it('records every structured attempt and strips the preloaded prefix once', async () => {
    const session = sessionFixture()
    const attempts: LockstepAttempt[] = []
    const wrapped = traceLockstepSession(session, 'preloaded', attempts, 1000)
    const input = { role: 'user' as const, content: 'evidence' }
    await wrapped.prompt([...LOCKSTEP_CONTEXT_PREFIX, input])
    await wrapped.prompt([...LOCKSTEP_CONTEXT_PREFIX, input])
    expect(session.prompt).toHaveBeenCalledTimes(2)
    expect(attempts).toHaveLength(2)
    expect(
      attempts.every(
        attempt =>
          attempt.inputCharacters === 8 &&
          attempt.outputCharacters === 6 &&
          attempt.raw === 'answer' &&
          attempt.completed,
      ),
    ).toBe(true)
    expect(session.prompt).toHaveBeenLastCalledWith(
      [input],
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    )
  })

  it('does not silently reuse a session without native cloning', () => {
    const session = sessionFixture()
    Reflect.deleteProperty(session, 'clone')
    expect(() => traceLockstepSession(session, 'preloaded', [], 1000)).toThrow()
  })

  it('records cancellation and destroys the interrupted session', async () => {
    const session = sessionFixture()
    const attempts: LockstepAttempt[] = []
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const wrapped = traceLockstepSession(session, 'per-request', attempts, 1000)
    await expect(
      wrapped.prompt([{ role: 'user', content: 'evidence' }], {
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow()
    expect(session.destroy).toHaveBeenCalledOnce()
    expect(attempts[0]?.completed).toBe(false)
  })
})
