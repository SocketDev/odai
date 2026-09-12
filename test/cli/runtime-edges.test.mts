import { Readable } from 'node:stream'

import { afterEach, expect, it, vi } from 'vitest'

import { parseCliArgs } from '../../src/cli/args.mts'
import { readInputText, withTimeout } from '../../src/cli/runtime.mts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('decodes piped UTF-8 after collecting split byte chunks', async () => {
  const bytes = Buffer.from('status: café\n')
  const stdin = Readable.from([bytes.subarray(0, 12), bytes.subarray(12)])
  vi.stubGlobal('process', { ...process, stdin })
  await expect(
    readInputText(parseCliArgs(['triage']), undefined),
  ).resolves.toBe('status: café\n')
})

it('returns an empty string for a closed empty pipe', async () => {
  vi.stubGlobal('process', { ...process, stdin: Readable.from([]) })
  await expect(
    readInputText(parseCliArgs(['triage']), undefined),
  ).resolves.toBe('')
})

it('preserves an input stream failure for the caller', async () => {
  const failure = new Error('fixture input stream closed unexpectedly')
  const stdin = new Readable({
    read() {
      this.destroy(failure)
    },
  })
  vi.stubGlobal('process', { ...process, stdin })
  await expect(readInputText(parseCliArgs(['triage']), undefined)).rejects.toBe(
    failure,
  )
})

it('clears the deadline after normalizing a non-Error rejection', async () => {
  vi.useFakeTimers()
  const result = withTimeout(Promise.reject(503), 1000, 'fixture operation')
  await expect(result).rejects.toBeInstanceOf(Error)
  expect(vi.getTimerCount()).toBe(0)
})
