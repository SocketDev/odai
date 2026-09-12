import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { main } from '../../../../../scripts/repo/cache/diagnostic/run.mts'

const mocks = vi.hoisted(() => ({ collect: vi.fn(), replay: vi.fn() }))
const directories: string[] = []

vi.mock(import('../../../../../scripts/repo/cache/crash/collect.mts'), () => ({
  collectGemmaCrashReports: mocks.collect,
}))
vi.mock(import('../../../../../scripts/repo/cache/retain.mts'), () => ({
  verifyGemmaReplay: mocks.replay,
}))

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await safeDelete(directory)
  }
})

async function kernelFile(contents: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'odai-diagnose-'))
  directories.push(directory)
  const file = path.join(directory, 'kernel.json')
  await fs.writeFile(file, contents)
  return file
}

test.each(
  [[], ['unknown'], ['kernel', 'extra'], ['kernel', '--unknown']].map(argv => ({
    argv,
  })),
)('rejects invalid arguments %j', async ({ argv }) => {
  await expect(main(argv)).rejects.toThrow()
  expect(mocks.collect).not.toHaveBeenCalled()
  expect(mocks.replay).not.toHaveBeenCalled()
})

test('preserves crash reports and returns parsed evidence', async () => {
  const data = {
    status: 'captured',
    databaseInitialized: true,
    reports: [{ status: 'captured', signal: 4 }],
  }
  mocks.collect.mockResolvedValue(data)
  expect(await main(['crashes', '--directory', 'crashpad'])).toEqual({
    exitCode: 0,
    data,
  })
  expect(mocks.collect).toHaveBeenCalledWith(path.resolve('crashpad'), {
    preserveReports: true,
  })
})

test.each([
  { status: 'unavailable', reports: [] },
  { status: 'captured', reports: [] },
  { status: 'captured', reports: [{ status: 'unavailable' }] },
  {
    status: 'captured',
    reports: [{ status: 'captured' }],
    truncated: true,
  },
])('does not pass incomplete crash evidence %j', async data => {
  mocks.collect.mockResolvedValue(data)
  expect((await main(['crashes', '--directory', 'crashpad'])).exitCode).toBe(1)
})

test('requires the crash directory', async () => {
  await expect(main(['crashes'])).rejects.toThrow()
  expect(mocks.collect).not.toHaveBeenCalled()
})

test('distinguishes an empty captured kernel log from unavailable evidence', async () => {
  const file = await kernelFile(JSON.stringify({ dmesg: [] }))
  expect(await main(['kernel', '--file', file, '--since', '0'])).toEqual({
    exitCode: 0,
    data: {
      status: 'captured',
      attribution: 'host-during-probe',
      events: [],
    },
  })
  await fs.writeFile(file, '{"private-message":true}')
  const invalid = await main(['kernel', '--file', file, '--since', '0'])
  expect(invalid.exitCode).toBe(1)
  expect(invalid.data).toEqual({
    status: 'unavailable',
    attribution: 'host-during-probe',
    events: [],
  })
})

test.each(['-1', 'Infinity', 'invalid'])(
  'rejects invalid kernel start time %s before reading',
  async since => {
    await expect(
      main(['kernel', '--file', 'missing.json', '--since', since]),
    ).rejects.toThrow()
  },
)

test('requires kernel time and file arguments', async () => {
  await expect(main(['kernel'])).rejects.toThrow()
  await expect(main(['kernel', '--since', '0'])).rejects.toThrow()
})

test('rejects missing files, oversized input and directories', async () => {
  const file = await kernelFile(' '.repeat(1024 ** 2 + 1))
  for (const invalid of [file, `${file}.missing`, path.dirname(file)]) {
    await expect(
      main(['kernel', '--file', invalid, '--since', '0']),
    ).rejects.toThrow()
  }
})

test.skipIf(process.platform === 'win32')(
  'rejects symlinked kernel inputs',
  async () => {
    const file = await kernelFile('{"dmesg":[]}')
    const link = `${file}.link`
    await fs.symlink(file, link)
    await expect(
      main(['kernel', '--file', link, '--since', '0']),
    ).rejects.toThrow()
  },
)

test.each([false, true])(
  'checks immutable replay identity with CPU override %s',
  async cpuOverride => {
    const data = { inferenceVerified: false, model: 'gemma4' }
    mocks.replay.mockResolvedValue(data)
    const imageDigest = `sha256:${'1'.repeat(64)}`
    const argv = [
      'replay',
      '--directory',
      'retained-artifact',
      '--browser-version',
      '153.0.8010.12',
      '--image-digest',
      imageDigest,
      '--source-run',
      '1234',
      ...(cpuOverride ? ['--cpu-override'] : []),
    ]
    expect(await main(argv)).toEqual({ exitCode: 0, data })
    expect(mocks.replay).toHaveBeenCalledWith({
      browserVersion: '153.0.8010.12',
      cpuOverride,
      directory: path.resolve('retained-artifact'),
      imageDigest,
      sourceRun: '1234',
    })
    mocks.replay.mockRejectedValue(new Error('private-metadata-contents'))
    await expect(main(argv)).rejects.not.toThrow('private-metadata-contents')
  },
)

test('requires replay provenance before verification', async () => {
  await expect(main(['replay'])).rejects.toThrow()
  expect(mocks.replay).not.toHaveBeenCalled()
})
