import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  main,
  verifyChromeCandidate,
} from '../../../../scripts/repo/update/chrome.mts'
import type { ChromeTool } from '../../../../scripts/repo/update/chrome.mts'
import type { GemmaImageConfig } from '../../../../scripts/repo/cache/image.mts'
type RunMain =
  typeof import('../../../../scripts/fleet/process/run-main.mts').runMain

const mocks = vi.hoisted(() => ({
  environment: new Map<string, string>(),
  root: '',
  failCleanup: false,
  entry: false,
  args: [] as string[],
  runMain: vi.fn<RunMain>(),
  prepare: vi.fn<
    (config: GemmaImageConfig) => Promise<{
      __proto__: null
      imageId: string
      seccompPath: string
      browserPath: string
    }>
  >(),
  verifyManifest: vi.fn(),
  verify: vi.fn(),
}))

vi.mock(import('@socketsecurity/lib-stable/fs/safe'), async original => {
  const actual = await original()
  return {
    ...actual,
    safeDelete: (...args: Parameters<typeof actual.safeDelete>) => {
      if (mocks.failCleanup) {
        mocks.failCleanup = false
        throw new Error('fixture cleanup failure')
      }
      return actual.safeDelete(...args)
    },
  }
})
vi.mock(import('../../../../scripts/fleet/paths.mts'), async original => ({
  ...(await original()),
  get FLEET_CACHE_DIR() {
    return path.join(mocks.root, 'fleet')
  },
}))
vi.mock(import('../../../../scripts/fleet/process/is-main-module.mts'), () => ({
  isMainModule: (url: string) =>
    mocks.entry && url.endsWith('/update/chrome.mts'),
}))
vi.mock(import('../../../../scripts/repo/cache/cli.mts'), async original => ({
  ...(await original()),
  getCacheArgs: () => mocks.args,
}))
vi.mock(import('../../../../scripts/fleet/process/run-main.mts'), () => ({
  runMain: mocks.runMain,
}))
vi.mock(import('@socketsecurity/lib-stable/env/rewire'), async original => ({
  ...(await original()),
  getEnvValue: (name: string) => mocks.environment.get(name),
}))
vi.mock(import('../../../../scripts/repo/cache/image.mts'), async original => ({
  ...(await original()),
  prepareGemmaImage: mocks.prepare,
}))
vi.mock(import('../../../../scripts/repo/cache/util.mts'), async original => ({
  ...(await original()),
  verifyCacheManifest: mocks.verifyManifest,
}))
vi.mock(import('../../../../scripts/repo/cache/run.mts'), async original => ({
  ...(await original()),
  main: mocks.verify,
}))

const candidate: ChromeTool = {
  origin: 'node-dist',
  platforms: {
    'linux-x64': {
      asset:
        'https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-beta/google-chrome-beta_153.0.8010.12-1_amd64.deb',
      integrity: `sha256-${'a'.repeat(64)}`,
    },
  },
  version: '153.0.8010.12-1',
}
const baseImage = `node:26.8.2-slim@sha256:${'b'.repeat(64)}`
const imageId = `sha256:${'c'.repeat(64)}`
const validReceipt = {
  architecture: 'x64',
  browserVersion: 'HeadlessChrome/153.0.8010.12',
  model: 'gemma4',
  offline: true,
  platform: 'linux',
  response: 'Gemma 4',
  sandbox: true,
}

function cloneChromeCandidate(): ChromeTool {
  return {
    ...candidate,
    platforms: { 'linux-x64': { ...candidate.platforms['linux-x64'] } },
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.entry = false
  mocks.args = []
  mocks.failCleanup = false
  mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-verifier-test-'))
  mocks.environment.clear()
  mocks.environment.set('ODAI_CACHE_PROFILE', '/example/gemma-export')
  mocks.environment.set('ODAI_CACHE_BASE_IMAGE', baseImage)
  mocks.environment.set(
    'ODAI_CACHE_DIAGNOSTICS',
    path.join(mocks.root, 'diagnostics'),
  )
  mocks.verifyManifest.mockResolvedValue({ files: [] })
  mocks.prepare.mockImplementation(async config => ({
    __proto__: null,
    imageId,
    browserPath: '/usr/bin/google-chrome-beta',
    seccompPath: path.join(config.directory, 'seccomp.json'),
  }))
  mocks.verify.mockResolvedValue({
    exitCode: 0,
    data: { ...validReceipt },
  })
})

afterEach(async () => {
  mocks.entry = false
  mocks.failCleanup = false
  for (const [config] of mocks.prepare.mock.calls) {
    await safeDelete(path.dirname(config.directory))
  }
  await safeDelete(mocks.root)
  vi.restoreAllMocks()
})

async function withDescriptor(
  value: unknown,
  callback: (file: string) => Promise<void>,
) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'chrome-candidate-test-'),
  )
  const file = path.join(directory, 'candidate.json')
  try {
    await fs.writeFile(file, JSON.stringify(value))
    await callback(file)
  } finally {
    await safeDelete(directory)
  }
}

test('verifies the exact candidate offline and removes its scratch directory', async () => {
  await verifyChromeCandidate('google-chrome-beta', candidate)
  const config = mocks.prepare.mock.calls[0]![0]
  expect(config).toMatchObject({ baseImage })
  expect(mocks.verifyManifest).toHaveBeenCalledWith('/example/gemma-export')
  expect(mocks.verifyManifest.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.prepare.mock.invocationCallOrder[0]!,
  )
  const diagnosticsRoot = path.join(mocks.root, 'diagnostics')
  const diagnostics = path.join(
    diagnosticsRoot,
    (await fs.readdir(diagnosticsRoot))[0]!,
  )
  expect(mocks.verify).toHaveBeenCalledWith([
    'verify',
    '--profile',
    '/example/gemma-export',
    '--destination',
    path.join(path.dirname(config.directory), 'profile'),
    '--browser',
    '/usr/bin/google-chrome-beta',
    '--image',
    imageId,
    '--seccomp',
    path.join(config.directory, 'seccomp.json'),
    '--diagnostics',
    path.join(diagnostics, 'probe'),
    '--cpu-override',
    '--timeout',
    '60000',
  ])
  expect(
    JSON.parse(
      await fs.readFile(path.join(diagnostics, 'candidate.json'), 'utf8'),
    ),
  ).toMatchObject({
    name: 'google-chrome-beta',
    version: candidate.version,
    baseImage,
  })
  expect(
    JSON.parse(await fs.readFile(path.join(diagnostics, 'image.json'), 'utf8')),
  ).toEqual({ imageId, browserPath: '/usr/bin/google-chrome-beta' })
  expect(existsSync(path.dirname(config.directory))).toBe(false)
})

test('preserves the verified candidate integrity and optional builder', async () => {
  const tool = cloneChromeCandidate()
  tool.platforms['linux-x64'].integrity = {
    value: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    src: 'https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages',
    date: '2026-09-11',
  }
  mocks.environment.set('ODAI_CACHE_BUILDER', 'example-builder')
  const before = JSON.stringify(tool)
  mocks.prepare.mockImplementationOnce(async config => {
    expect(config.builder).toBe('example-builder')
    expect(
      JSON.parse(await fs.readFile(config.browserPinFile!, 'utf8')),
    ).toEqual({
      name: 'google-chrome-beta',
      ...tool,
    })
    expect((await fs.stat(config.browserPinFile!)).mode & 0o777).toBe(0o600)
    return {
      __proto__: null,
      imageId,
      seccompPath: path.join(config.directory, 'seccomp.json'),
      browserPath: '/usr/bin/google-chrome-beta',
    }
  })
  await verifyChromeCandidate('google-chrome-beta', tool)
  expect(JSON.stringify(tool)).toBe(before)
})

test.each([
  ['ODAI_CACHE_PROFILE', undefined],
  ['ODAI_CACHE_PROFILE', ''],
  ['ODAI_CACHE_PROFILE', 'relative/profile'],
  ['ODAI_CACHE_PROFILE', '/example/comma,profile'],
  ['ODAI_CACHE_BASE_IMAGE', undefined],
  ['ODAI_CACHE_BASE_IMAGE', 'node:26'],
  ['ODAI_CACHE_BASE_IMAGE', `sha256:${'a'.repeat(64)}`],
  ['ODAI_CACHE_DIAGNOSTICS', 'relative/diagnostics'],
  ['ODAI_CACHE_DIAGNOSTICS', '/example/comma,diagnostics'],
])('rejects invalid %s before build or verification', async (name, value) => {
  if (value === undefined) {
    mocks.environment.delete(name!)
  } else {
    mocks.environment.set(name!, value)
  }
  await expect(
    verifyChromeCandidate('google-chrome-beta', candidate),
  ).rejects.toThrow()
  expect(mocks.verifyManifest).not.toHaveBeenCalled()
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(mocks.verify).not.toHaveBeenCalled()
})

test('rejects altered source hashes before building the browser', async () => {
  const failure = new Error('fixture hash mismatch')
  mocks.verifyManifest.mockRejectedValueOnce(failure)
  await expect(
    verifyChromeCandidate('google-chrome-beta', candidate),
  ).rejects.toMatchObject({ cause: failure })
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(mocks.verify).not.toHaveBeenCalled()
})

test.each([
  { name: 'example-browser', tool: candidate },
  { name: 'google-chrome-beta', tool: { ...candidate, version: '153' } },
  {
    name: 'google-chrome-beta',
    tool: { ...candidate, version: '154.0.8037.0-1' },
  },
  ...[
    {
      asset: 'https://example.com/chrome.deb',
      integrity: candidate.platforms['linux-x64'].integrity,
    },
    { asset: candidate.platforms['linux-x64'].asset, integrity: '' },
    {
      asset: candidate.platforms['linux-x64'].asset,
      integrity: 'sha512-invalid',
    },
    {
      asset: candidate.platforms['linux-x64'].asset,
      integrity: `md5-${'a'.repeat(32)}`,
    },
    {
      asset: candidate.platforms['linux-x64'].asset,
      integrity: `sha256-${'a'.repeat(63)}`,
    },
  ].map(platform => ({
    name: 'google-chrome-beta',
    tool: { ...candidate, platforms: { 'linux-x64': platform } },
  })),
])(
  'rejects malformed or mismatched candidates before reading the cache %#',
  async ({ name, tool }) => {
    await expect(verifyChromeCandidate(name, tool)).rejects.toThrow()
    expect(mocks.verifyManifest).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  },
)

test('accepts the Stable package and exact Chrome product version', async () => {
  const tool = cloneChromeCandidate()
  tool.version = '153.0.8010.12'
  tool.platforms['linux-x64'].asset = tool.platforms[
    'linux-x64'
  ].asset.replaceAll('google-chrome-beta', 'google-chrome-stable')
  mocks.prepare.mockImplementationOnce(async config => ({
    __proto__: null,
    imageId,
    seccompPath: path.join(config.directory, 'seccomp.json'),
    browserPath: '/usr/bin/google-chrome-stable',
  }))
  mocks.verify.mockResolvedValueOnce({
    exitCode: 0,
    data: { ...validReceipt, browserVersion: 'Chrome/153.0.8010.12' },
  })
  await verifyChromeCandidate('google-chrome-stable', tool)
  expect(mocks.verify.mock.calls[0]![0]).toContain(
    '/usr/bin/google-chrome-stable',
  )
})

test.each([
  { browserVersion: undefined },
  { browserVersion: 'HeadlessChrome/154.0.8037.0' },
  { browserVersion: 'Other/153.0.8010.12' },
  { response: 'Gemini Nano' },
  { offline: false },
  { sandbox: false },
])(
  'rejects an invalid receipt and removes the verification directory %#',
  async changed => {
    mocks.verify.mockResolvedValueOnce({
      exitCode: 0,
      data: { ...validReceipt, ...changed },
    })
    await expect(
      verifyChromeCandidate('google-chrome-beta', candidate),
    ).rejects.toThrow()
    expect(
      existsSync(path.dirname(mocks.prepare.mock.calls[0]![0].directory)),
    ).toBe(false)
  },
)

test('removes its scratch directory after build or inference failure', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('fixture missing Docker'))
  await expect(
    verifyChromeCandidate('google-chrome-beta', candidate),
  ).rejects.toThrow()
  expect(mocks.verify).not.toHaveBeenCalled()
  expect(
    existsSync(path.dirname(mocks.prepare.mock.calls[0]![0].directory)),
  ).toBe(false)
  mocks.verify.mockRejectedValueOnce(new Error('fixture deadline'))
  await expect(
    verifyChromeCandidate('google-chrome-beta', candidate),
  ).rejects.toThrow()
  expect(
    existsSync(path.dirname(mocks.prepare.mock.calls[1]![0].directory)),
  ).toBe(false)
})

test('rejects a failed exit even when its response looks successful', async () => {
  mocks.verify.mockResolvedValueOnce({
    exitCode: 1,
    data: { ...validReceipt },
  })
  await expect(
    verifyChromeCandidate('google-chrome-beta', candidate),
  ).rejects.toThrow()
})

test('retains private evidence and the inference cause when scratch cleanup also fails', async () => {
  const failure = new Error('fixture inference failure')
  mocks.verify.mockRejectedValueOnce(failure)
  mocks.failCleanup = true
  await expect(
    verifyChromeCandidate('google-chrome-beta', candidate),
  ).rejects.toMatchObject({ cause: failure })
  const root = path.join(mocks.root, 'diagnostics')
  const evidence = path.join(root, (await fs.readdir(root))[0]!)
  expect((await fs.stat(evidence)).mode & 0o777).toBe(0o700)
  expect(
    JSON.parse(await fs.readFile(path.join(evidence, 'image.json'), 'utf8')),
  ).toMatchObject({ imageId })
})

test('a cleanup failure prevents a successful result', async () => {
  mocks.failCleanup = true
  await expect(
    verifyChromeCandidate('google-chrome-beta', candidate),
  ).rejects.toThrow()
})

test('defaults retained evidence to the fleet cache', async () => {
  mocks.environment.delete('ODAI_CACHE_DIAGNOSTICS')
  await verifyChromeCandidate('google-chrome-beta', candidate)
  expect(
    await fs.readdir(
      path.join(mocks.root, 'fleet', 'ai', 'odai', 'diagnostics'),
    ),
  ).toHaveLength(1)
})

test('uses separate scratch directories for simultaneous candidates', async () => {
  const results = await Promise.all([
    verifyChromeCandidate('google-chrome-beta', candidate),
    verifyChromeCandidate('google-chrome-beta', candidate),
  ])
  expect(results).toEqual([undefined, undefined])
  const directories = mocks.prepare.mock.calls.map(([config]) =>
    path.dirname(config.directory),
  )
  expect(new Set(directories).size).toBe(2)
  for (let i = 0, { length } = directories; i < length; i += 1) {
    const directory = directories[i]!
    expect(existsSync(directory)).toBe(false)
  }
})

test('the candidate CLI returns a structured verified result', async () => {
  await withDescriptor(
    { name: 'google-chrome-beta', ...candidate },
    async file => {
      expect(await main(['--candidate', file, '--json'])).toEqual({
        exitCode: 0,
        data: {
          name: 'google-chrome-beta',
          version: candidate.version,
          verified: true,
        },
      })
    },
  )
})

test.each([
  undefined,
  {},
  { name: 'google-chrome-beta' },
  { name: 'google-chrome-beta', ...candidate, origin: 'other' },
  { name: 'google-chrome-beta', version: candidate.version, platforms: [] },
])('rejects malformed CLI descriptors %#', async value => {
  await withDescriptor(value ?? false, async file => {
    await expect(main(['--candidate', file])).rejects.toThrow()
  })
  expect(mocks.prepare).not.toHaveBeenCalled()
})

test('requires the descriptor argument and rejects unknown flags', async () => {
  await expect(main([])).rejects.toThrow()
  await expect(main(['--unknown'])).rejects.toThrow()
})

test('wires the CLI through the shared JSON and description runner', async () => {
  await withDescriptor(
    { name: 'google-chrome-beta', ...candidate },
    async file => {
      mocks.entry = true
      mocks.args = ['--candidate', file]
      vi.resetModules()
      await import('../../../../scripts/repo/update/chrome.mts')
      const { 0: callback, 1: meta } = mocks.runMain.mock.calls[0]!
      expect(meta).toMatchObject({
        describe: expect.any(String),
        help: expect.any(String),
        json: 'result',
      })
      await expect(callback()).resolves.toMatchObject({
        exitCode: 0,
        data: { verified: true },
      })
    },
  )
})
