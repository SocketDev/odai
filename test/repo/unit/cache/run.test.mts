import assert from 'node:assert/strict'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  dockerProbeArguments,
  main,
  validateOfflineReceipt,
} from '../../../../scripts/repo/cache/run.mts'

const mocks = vi.hoisted(() => ({
  exportCache: vi.fn(),
  ensureSpace: vi.fn(),
  initialize: vi.fn(),
  probe: vi.fn(),
  prepareImage: vi.fn(),
  spawn: vi.fn(),
  verify: vi.fn(),
}))

vi.mock(import('../../../../scripts/repo/cache/space.mts'), () => ({
  ensureGemmaProvisionSpace: mocks.ensureSpace,
}))
vi.mock(
  import('../../../../scripts/repo/cache/image.mts'),
  async importOriginal => ({
    ...(await importOriginal()),
    prepareGemmaImage: mocks.prepareImage,
  }),
)

vi.mock(
  import('@socketsecurity/lib-stable/process/spawn/child'),
  async importOriginal => ({
    ...(await importOriginal()),
    spawn: mocks.spawn,
  }),
)
vi.mock(
  import('../../../../scripts/repo/cache/util.mts'),
  async importOriginal => ({
    ...(await importOriginal()),
    exportGemmaCache: mocks.exportCache,
    initializeCacheProfile: mocks.initialize,
    verifyCacheManifest: mocks.verify,
  }),
)
vi.mock(
  import('../../../../scripts/repo/cache/browser.mts'),
  async importOriginal => ({
    ...(await importOriginal()),
    probeGemmaBrowser: mocks.probe,
  }),
)

beforeEach(() => {
  vi.resetAllMocks()
  mocks.initialize.mockResolvedValue(undefined)
  mocks.ensureSpace.mockResolvedValue({
    availableAfterBytes: 30 * 1024 ** 3,
    availableBeforeBytes: 30 * 1024 ** 3,
    swept: false,
  })
  mocks.verify.mockResolvedValue({ files: [] })
  mocks.exportCache.mockResolvedValue({ files: [] })
  mocks.probe.mockResolvedValue({ model: 'gemma4' })
  mocks.prepareImage.mockResolvedValue({ image: `sha256:${'1'.repeat(64)}` })
  mocks.spawn.mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({
      model: 'gemma4',
      platform: 'linux',
      architecture: 'x64',
      offline: true,
      sandbox: true,
      response: 'Gemma 4',
    }),
    stderr: '',
  })
})

function stringArguments(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(argument => typeof argument === 'string')
  )
}

const options = {
  browser: '/usr/bin/google-chrome-beta',
  image: `sha256:${'1'.repeat(64)}`,
  name: 'odai-cache-example',
  phase: 'verify' as const,
  profile: '/tmp/odai-profile',
  seccomp: '/tmp/seccomp.json',
  timeoutMs: 60_000,
  uid: 1000,
}

test('uses an immutable local image with no network and a non-root sandboxed browser', () => {
  const args = dockerProbeArguments(options)
  expect(
    args.slice(args.indexOf('--network'), args.indexOf('--network') + 2),
  ).toEqual(['--network', 'none'])
  expect(
    args.slice(args.indexOf('--pull'), args.indexOf('--pull') + 2),
  ).toEqual(['--pull', 'never'])
  expect(
    args.slice(args.indexOf('--platform'), args.indexOf('--platform') + 2),
  ).toEqual(['--platform', 'linux/amd64'])
  expect(
    args.slice(args.indexOf('--user'), args.indexOf('--user') + 2),
  ).toEqual(['--user', '1000'])
  expect(args).not.toContain('--privileged')
  expect(JSON.parse(args.at(-1)!)).toMatchObject({
    offline: true,
    browser: options.browser,
    timeoutMs: 60_000,
  })
})

test('mounts requested diagnostic evidence outside the disposable container', () => {
  const args = dockerProbeArguments({
    ...options,
    diagnostics: '/private-evidence',
  })
  expect(args).toContain('type=bind,src=/private-evidence,dst=/private')
  expect(args).toContain('BREAKPAD_DUMP_LOCATION=/private/crashes')
  const data: unknown = JSON.parse(args.at(-1)!)
  expect(data).toMatchObject({
    diagnosticRoot: '/private',
    imageDigest: options.image,
  })
  expect(args).toContain('none')
})

test('rejects mutable images and root execution', () => {
  expect(() =>
    dockerProbeArguments({ ...options, image: 'example/image:latest' }),
  ).toThrow()
  expect(() => dockerProbeArguments({ ...options, uid: 0 })).toThrow()
  expect(
    dockerProbeArguments({
      ...options,
      image: `example/image@${options.image}`,
    }),
  ).toContain(`example/image@${options.image}`)
})

test.each(['provision', 'verify'] as const)(
  'passes the CPU option to the %s container without changing isolation',
  phase => {
    const args = dockerProbeArguments({ ...options, cpuOverride: true, phase })
    expect(JSON.parse(args.at(-1)!)).toMatchObject({
      cpuOverride: true,
      offline: phase === 'verify',
    })
    expect(args.includes('--network')).toBe(phase === 'verify')
    expect(args).not.toContain('--privileged')
  },
)

test('allows networking only for the explicit provision phase', () => {
  const args = dockerProbeArguments({ ...options, phase: 'provision' })
  expect(args).not.toContain('--network')
  expect(JSON.parse(args.at(-1)!)).toMatchObject({ offline: false })
})

test('rejects unknown commands and unbounded timeouts before touching profiles', async () => {
  await expect(main(['unknown'])).rejects.toThrow()
  await expect(
    main(['provision', '--profile', '/unused', '--timeout', 'Infinity']),
  ).rejects.toThrow()
  await expect(
    main(['provision', '--profile', '/unused', '--timeout', '999']),
  ).rejects.toThrow()
  await expect(main(['provision'])).rejects.toThrow()
})

test('requires a complete offline inference receipt', () => {
  const receipt = {
    model: 'gemma4',
    platform: 'linux',
    architecture: 'x64',
    offline: true,
    sandbox: true,
    response: 'Gemma 4',
  }
  expect(validateOfflineReceipt(receipt)).toEqual(receipt)
  for (const value of [
    {},
    { ...receipt, offline: false },
    { ...receipt, sandbox: false },
    { ...receipt, platform: 'darwin' },
    { ...receipt, architecture: 'arm64' },
    { ...receipt, response: 'Gemini Nano' },
  ]) {
    expect(() => validateOfflineReceipt(value)).toThrow()
  }
})

test('provisions an owned profile and exports through the minimal cache copier', async () => {
  expect(
    await main([
      'provision',
      '--profile',
      '/example/source',
      '--browser',
      options.browser,
    ]),
  ).toMatchObject({ exitCode: 0, data: { model: 'gemma4' } })
  expect(mocks.initialize).toHaveBeenCalledWith('/example/source')
  expect(mocks.ensureSpace).toHaveBeenCalledWith('/example/source')
  expect(mocks.probe).toHaveBeenCalledWith(
    expect.objectContaining({ offline: false, profile: '/example/source' }),
  )
  expect(
    await main([
      'export',
      '--profile',
      '/example/source',
      '--destination',
      '/example/export',
    ]),
  ).toMatchObject({ exitCode: 0 })
  expect(mocks.exportCache).toHaveBeenCalledWith(
    '/example/source',
    '/example/export',
  )
})

const verifyArgs = [
  'verify',
  '--profile',
  '/example/source',
  '--destination',
  '/example/verify',
  '--browser',
  options.browser,
  '--image',
  options.image,
  '--seccomp',
  options.seccomp,
]

test('passes the explicit CPU option through native provisioning and Docker verification', async () => {
  await main([
    'provision',
    '--profile',
    '/example/source',
    '--browser',
    options.browser,
    '--cpu-override',
  ])
  expect(mocks.probe).toHaveBeenCalledWith(
    expect.objectContaining({ cpuOverride: true, offline: false }),
  )
  await main([...verifyArgs, '--cpu-override'])
  const args: unknown = mocks.spawn.mock.calls[0]![1]
  assert.ok(stringArguments(args))
  expect(JSON.parse(args.at(-1)!)).toMatchObject({
    cpuOverride: true,
    offline: true,
  })
})

test('checks hashes, verifies a copy and removes only its owned container', async () => {
  expect(await main(verifyArgs)).toMatchObject({
    exitCode: 0,
    data: { offline: true },
  })
  expect(mocks.verify).toHaveBeenCalledWith('/example/source')
  expect(mocks.exportCache).toHaveBeenCalledWith(
    '/example/source',
    '/example/verify',
  )
  expect(mocks.spawn).toHaveBeenNthCalledWith(
    1,
    'docker',
    expect.any(Array),
    expect.objectContaining({ stdioString: true, throws: false }),
  )
  const runArgs: unknown = mocks.spawn.mock.calls[0]![1]
  assert.ok(stringArguments(runArgs))
  const name = runArgs[runArgs.indexOf('--name') + 1]
  expect(mocks.spawn).toHaveBeenLastCalledWith(
    'docker',
    ['container', 'rm', '--force', name],
    expect.objectContaining({ timeout: 10_000 }),
  )
})

test('removes its container on timeout and refuses failed or malformed receipts', async () => {
  mocks.spawn.mockRejectedValueOnce(new Error('fixture timeout'))
  await expect(main(verifyArgs)).rejects.toThrow()
  expect(mocks.spawn).toHaveBeenCalledTimes(2)
  mocks.spawn.mockResolvedValueOnce({ code: 1, stderr: 'fixture failure' })
  await expect(main(verifyArgs)).rejects.toThrow()
  mocks.spawn.mockResolvedValueOnce({ code: 0, stdout: '{}' })
  await expect(main(verifyArgs)).rejects.toThrow()
})

test('prepares the pinned image and provisions it through the network-enabled phase', async () => {
  expect(
    await main([
      'prepare-image',
      '--base-image',
      'example/node@sha256:fixture',
      '--destination',
      '/example/image',
    ]),
  ).toMatchObject({ exitCode: 0 })
  expect(mocks.prepareImage).toHaveBeenCalledWith({
    baseImage: 'example/node@sha256:fixture',
    browserPinFile: undefined,
    builder: undefined,
    directory: '/example/image',
  })
  await main([
    'prepare-image',
    '--base-image',
    'example/node@sha256:fixture',
    '--browser-pin',
    '/example/chrome-control.json',
    '--destination',
    '/example/control',
  ])
  expect(mocks.prepareImage).toHaveBeenLastCalledWith({
    baseImage: 'example/node@sha256:fixture',
    browserPinFile: '/example/chrome-control.json',
    builder: undefined,
    directory: '/example/control',
  })
  mocks.spawn.mockResolvedValueOnce({
    code: 0,
    stdout: JSON.stringify({
      model: 'gemma4',
      platform: 'linux',
      architecture: 'x64',
      offline: false,
      sandbox: true,
      response: 'Gemma 4',
    }),
  })
  expect(
    await main([
      'provision',
      '--profile',
      '/example/profile',
      '--image',
      options.image,
      '--seccomp',
      options.seccomp,
    ]),
  ).toMatchObject({ exitCode: 0 })
  const args: unknown = mocks.spawn.mock.calls[0]![1]
  assert.ok(stringArguments(args))
  expect(args).not.toContain('--network')
  expect(JSON.parse(args.at(-1)!)).toMatchObject({
    offline: false,
    browser: '/usr/bin/google-chrome-beta',
  })
})
