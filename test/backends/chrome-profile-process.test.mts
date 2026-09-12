import { afterEach, expect, test, vi } from 'vitest'

import {
  cloneDir,
  readChromeMajorVersion,
  resolveBridgeConfig,
  systemChromeUserDataDirFor,
} from '../../src/backends/chrome-profile.mts'
import {
  ODAI_CHROME_ENV_VAR,
  ODAI_CHROME_USER_DATA_DIR_ENV_VAR,
} from '../../src/backends/chrome-models.mts'

const fixtures = vi.hoisted(() => ({
  copy: vi.fn(),
  exec: vi.fn(),
  exists: vi.fn(),
}))
vi.mock(import('node:child_process'), async importOriginal => {
  const original = await importOriginal()
  const holder = { execFile: original.execFile }
  vi.spyOn(holder, 'execFile').mockImplementation((...args) =>
    fixtures.exec(...args),
  )
  return { ...original, execFile: holder.execFile }
})
vi.mock(import('node:fs'), async importOriginal => ({
  ...(await importOriginal()),
  existsSync: fixtures.exists,
}))
vi.mock(import('node:fs/promises'), async importOriginal => ({
  ...(await importOriginal()),
  cp: fixtures.copy,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  fixtures.copy.mockReset()
  fixtures.exec.mockReset()
  fixtures.exists.mockReset()
})

test.each(['darwin', 'linux'])(
  'failed native clone on %s falls back to recursive copy',
  async platform => {
    vi.stubGlobal('process', { ...process, platform })
    fixtures.exists.mockReturnValue(true)
    fixtures.exec.mockImplementation(
      (
        file: string,
        args: string[],
        callback: (error: Error | null) => void,
      ) => {
        expect(file).toBe('cp')
        expect(args[0]).toBe('-R')
        callback(new Error('fixture clone unsupported'))
      },
    )
    fixtures.copy.mockResolvedValue(undefined)
    await cloneDir('/fixture/source', '/fixture/target')
    expect(fixtures.exec).toHaveBeenCalledWith(
      'cp',
      [
        '-R',
        platform === 'darwin' ? '-c' : '--reflink=auto',
        '/fixture/source/.',
        '/fixture/target',
      ],
      expect.any(Function),
    )
    expect(fixtures.copy).toHaveBeenCalledWith(
      '/fixture/source',
      '/fixture/target',
      { recursive: true },
    )
  },
)

test('Windows cloning uses filesystem copy without invoking cp', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  fixtures.copy.mockRejectedValue(new Error('fixture destination unavailable'))
  await expect(
    cloneDir('/fixture/source', '/fixture/target'),
  ).rejects.toBeInstanceOf(Error)
  expect(fixtures.exec).not.toHaveBeenCalled()
})

test('Chrome executable failures do not produce a usable version', async () => {
  fixtures.exec.mockImplementation(
    (
      file: string,
      args: string[],
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      expect(file).toBe('/fixture/chrome')
      expect(args).toEqual(['--version'])
      callback(new Error('fixture not executable'), 'Chrome 150.0')
    },
  )
  expect(await readChromeMajorVersion('/fixture/chrome')).toBeUndefined()
})

test('environment paths select a Chrome executable and caller-owned profile', async () => {
  fixtures.exists.mockReturnValue(true)
  const result = await resolveBridgeConfig({
    env: {
      [ODAI_CHROME_ENV_VAR]: '/fixture/chrome',
      [ODAI_CHROME_USER_DATA_DIR_ENV_VAR]: '/fixture/profile',
    },
  })
  expect(result.chromePath).toBe('/fixture/chrome')
  expect(result.chromePathCandidates).toEqual(['/fixture/chrome'])
  expect(result.userDataDir).toBe('/fixture/profile')
  expect(systemChromeUserDataDirFor('win32', {}, 'C:\\fixture')).toBe(
    'C:\\fixture\\Google\\Chrome\\User Data',
  )
})
