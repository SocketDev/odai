import process from 'node:process'
import { afterEach, expect, test, vi } from 'vitest'
import {
  getCacheArgs,
  runCacheMain,
} from '../../../../scripts/repo/cache/cli.mts'

const mocks = vi.hoisted(() => ({ runMain: vi.fn() }))
const originalArgv = process.argv

vi.mock(import('../../../../scripts/fleet/process/run-main.mts'), () => ({
  runMain: mocks.runMain,
}))

afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
  mocks.runMain.mockReset()
})

test('removes only the shared JSON option', () => {
  process.argv = ['node', 'cache.mts', 'kernel', '--json', '--since', '0']
  expect(getCacheArgs()).toEqual(['kernel', '--since', '0'])
})

test.each([false, true])(
  'returns the real exit code and prints results only in JSON mode %s',
  async json => {
    process.argv = ['node', 'cache.mts', ...(json ? ['--json'] : [])]
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const result = { exitCode: 1, data: { status: 'unavailable' } }
    const callback = vi.fn().mockResolvedValue(result)
    const meta = { describe: 'inspect cache', help: 'Usage: cache' }
    runCacheMain(callback, meta)
    expect(mocks.runMain).toHaveBeenCalledWith(expect.any(Function), meta)
    const runner = mocks.runMain.mock.calls[0]![0] as () => Promise<number>
    expect(await runner()).toBe(1)
    if (json) {
      expect(JSON.parse(String(write.mock.calls[0]![0]))).toEqual(result)
    } else {
      expect(write).not.toHaveBeenCalled()
    }
  },
)

test('leaves rejected operations to the existing failure handler', async () => {
  const error = new Error('example failure')
  runCacheMain(() => Promise.reject(error), {
    describe: 'inspect cache',
    help: 'Usage: cache',
  })
  const runner = mocks.runMain.mock.calls[0]![0] as () => Promise<number>
  await expect(runner()).rejects.toBe(error)
})
