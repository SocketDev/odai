import { ChildProcess } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'

import { afterEach, expect, test, vi } from 'vitest'

import { spawnShim } from '../../src/backends/apple-fm-shim.mts'

const fixtures = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock(import('@socketsecurity/lib/process/spawn/child'), () => ({
  spawn: fixtures.spawn,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  fixtures.spawn.mockReset()
})

function createProcessFixture() {
  const child = new ChildProcess()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true)
  vi.spyOn(child, 'unref').mockImplementation(() => {})
  const completion = Promise.withResolvers<void>()
  fixtures.spawn.mockReturnValue(
    Object.assign(completion.promise, { process: child }),
  )
  const handle = spawnShim({ command: 'fixture-shim', args: [] })
  return { child, completion, handle, kill }
}

test('missing stdin rejects the request and removes its timeout', async () => {
  vi.useFakeTimers()
  const { child, completion, handle, kill } = createProcessFixture()
  // oxlint-disable-next-line socket/prefer-undefined-over-null -- Node pipe state.
  child.stdin = null
  await expect(handle.request({ op: 'create' }, 100)).rejects.toBeInstanceOf(
    Error,
  )
  expect(vi.getTimerCount()).toBe(0)
  completion.resolve()
  await completion.promise
  handle.dispose()
  expect(kill).not.toHaveBeenCalled()
})

test('a failed stdin write rejects and removes the pending request', async () => {
  vi.useFakeTimers()
  const { child, completion, handle } = createProcessFixture()
  const input = new Writable({
    write(chunk, encoding, callback) {
      expect(Buffer.isBuffer(chunk)).toBe(true)
      expect(encoding).toBe('buffer')
      callback(new Error('fixture pipe closed'))
    },
  })
  input.on('error', () => {})
  child.stdin = input
  await expect(handle.request({ op: 'prompt' }, 100)).rejects.toBeInstanceOf(
    Error,
  )
  expect(vi.getTimerCount()).toBe(0)
  completion.reject(new Error('fixture process failed'))
  await Promise.resolve()
  await expect(handle.request({ op: 'prompt' }, 100)).rejects.toBeInstanceOf(
    Error,
  )
})

test('a late write failure after a reply leaves subsequent requests intact', async () => {
  const { child, completion, handle } = createProcessFixture()
  let failWrite: ((error?: Error | null | undefined) => void) | undefined
  const input = new Writable({
    write(chunk, encoding, callback) {
      expect(Buffer.isBuffer(chunk)).toBe(true)
      expect(encoding).toBe('buffer')
      failWrite = callback
    },
  })
  input.on('error', () => {})
  child.stdin = input
  const reply = handle.request({ op: 'prompt' }, 1000)
  child.stdout?.emit('data', Buffer.from('{"ok":true,"text":"ready"}\n'))
  await expect(reply).resolves.toEqual({ ok: true, text: 'ready' })
  failWrite?.(new Error('fixture late write failure'))
  completion.resolve()
  await completion.promise
})

test('unsolicited output is ignored and stderr process failure rejects pending work', async () => {
  const { child, completion, handle, kill } = createProcessFixture()
  child.stdout?.emit('data', Buffer.from('{"ok":true}\n'))
  const pending = handle.request({ op: 'prompt' }, 1000)
  const rejected = expect(pending).rejects.toBeInstanceOf(Error)
  child.stderr?.emit('data', Buffer.from('fixture diagnostic'))
  completion.reject(new Error('fixture spawn failed'))
  await rejected
  handle.dispose()
  expect(kill).not.toHaveBeenCalled()
})
