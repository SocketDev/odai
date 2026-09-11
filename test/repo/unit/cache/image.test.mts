import assert from 'node:assert/strict'
import path from 'node:path'
import { beforeEach, test, vi } from 'vitest'
import { prepareGemmaImage } from '../../../../scripts/repo/cache/image.mts'

const state = vi.hoisted(() => ({
  cp: vi.fn(),
  bundleCreate: vi.fn(),
  bundleClose: vi.fn(),
  bundleGenerate: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
  writeFile: vi.fn(),
  remove: vi.fn(),
  spawn: vi.fn(),
}))
vi.mock(import('rolldown'), () => ({
  rolldown: state.bundleCreate,
}))
vi.mock(import('node:fs/promises'), async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    default: {
      ...actual.default,
      cp: state.cp,
      mkdir: state.mkdir,
      readFile: state.readFile,
      realpath: state.realpath,
      writeFile: state.writeFile,
    },
  }
})
vi.mock(import('@socketsecurity/lib-stable/fs/safe'), () => ({
  safeDelete: state.remove,
}))
vi.mock(import('@socketsecurity/lib-stable/process/spawn/child'), () => ({
  spawn: state.spawn,
}))

const baseImage = `node@sha256:${'a'.repeat(64)}`
const imageId = `sha256:${'b'.repeat(64)}`
const directory = path.resolve('/example/gemma-context')

beforeEach(() => {
  vi.resetAllMocks()
  state.bundleCreate.mockResolvedValue({
    generate: state.bundleGenerate,
    close: state.bundleClose,
  })
  state.bundleGenerate.mockResolvedValue({
    output: [
      {
        type: 'chunk',
        code: 'export const probe = true\n',
        imports: ['node:fs', 'playwright-core'],
        dynamicImports: [],
      },
    ],
  })
  state.realpath.mockResolvedValue('/example/playwright-core/package.json')
  state.readFile.mockImplementation(async (file: string) => {
    if (file.endsWith('tools.json')) {
      return JSON.stringify({
        tools: {
          ...Object.fromEntries(
            [
              'binutils',
              'binutils-lib',
              'binutils-sframe',
              'binutils-ctf',
              'binutils-jansson',
            ].map(name => [
              name,
              {
                version: '2.44-3',
                platforms: {
                  'linux-x64': {
                    asset: `https://example.com/${name}.deb`,
                    integrity: 'sha256-example',
                  },
                },
              },
            ]),
          ),
          'google-chrome-beta': {
            version: '154.0.0.0-1',
            platforms: {
              'linux-x64': {
                asset: 'https://example.com/chrome.deb',
                integrity: {
                  value: 'sha512-example',
                  src: 'https://example.com/provenance',
                  date: '2026-08-01',
                },
              },
            },
          },
          'playwright-seccomp': {
            version: '1.62.1',
            platforms: {
              'linux-x64': {
                asset: 'https://example.com/seccomp.json',
                integrity: 'sha256-example',
              },
            },
          },
        },
      })
    }
    return file.endsWith('package.json')
      ? JSON.stringify({ version: '1.62.1' })
      : imageId
  })
  state.spawn.mockResolvedValue({ stdout: 'local-context\n' })
})

test('stages only pinned inputs and loads an immutable amd64 image with the current context', async () => {
  const result = await prepareGemmaImage({ baseImage, directory })
  assert.deepEqual(
    { ...result },
    {
      imageId,
      seccompPath: path.join(directory, 'seccomp.json'),
      browserPath: '/usr/bin/google-chrome-beta',
    },
  )
  assert.deepEqual(state.spawn.mock.calls[0]?.slice(0, 2), [
    'docker',
    ['context', 'show'],
  ])
  const downloads = state.spawn.mock.calls.slice(1, 3)
  assert.equal(downloads[0]?.[1][1], 'https://example.com/chrome.deb')
  assert.equal(downloads[0]?.[1][2], 'sha512-example')
  assert.deepEqual(downloads[0]?.[1].slice(-4), [
    '--src',
    'https://example.com/provenance',
    '--date',
    '2026-08-01',
  ])
  assert.equal(downloads[1]?.[1][2], 'sha256-example')
  assert.deepEqual(state.cp.mock.calls, [
    [
      '/example/playwright-core',
      path.join(directory, 'node_modules/playwright-core'),
      { recursive: true, dereference: true },
    ],
  ])
  const files = new Map(
    state.writeFile.mock.calls.map(([file, bytes]) => [
      path.basename(file),
      bytes,
    ]),
  )
  assert.equal(
    files.get('browser.generated.mjs'),
    'export const probe = true\n',
  )
  assert.ok(files.get('Dockerfile').startsWith(`FROM ${baseImage}\n`))
  assert.ok(files.get('Dockerfile').endsWith('USER node\n'))
  assert.ok(!files.get('Dockerfile').includes('--no-sandbox'))
  assert.ok(files.get('.dockerignore').startsWith('*\n'))
  assert.deepEqual(state.spawn.mock.calls[8]?.[1], [
    'buildx',
    'build',
    '--builder',
    'local-context',
    '--platform',
    'linux/amd64',
    '--load',
    '--iidfile',
    path.join(directory, 'image-id'),
    directory,
  ])
  assert.equal(state.remove.mock.calls.length, 0)
})

test('uses an explicit builder without changing global Docker configuration', async () => {
  await prepareGemmaImage({ baseImage, directory, builder: 'example-builder' })
  assert.equal(state.spawn.mock.calls.length, 8)
  assert.equal(state.spawn.mock.calls[7]?.[1][3], 'example-builder')
})

test('rejects mutable base images before file or process operations', async () => {
  await assert.rejects(
    prepareGemmaImage({ directory, baseImage: 'node:latest' }),
  )
  assert.equal(state.mkdir.mock.calls.length, 0)
  assert.equal(state.spawn.mock.calls.length, 0)
})

test('rejects mismatched Playwright before creating the context', async () => {
  state.readFile.mockResolvedValueOnce(
    JSON.stringify({
      tools: {
        'google-chrome-beta': {
          version: '154',
          platforms: {
            'linux-x64': {
              asset: 'https://example.com/chrome.deb',
              integrity: 'sha512-example',
            },
          },
        },
        'playwright-seccomp': {
          version: '0.0.0',
          platforms: {
            'linux-x64': {
              asset: 'https://example.com/seccomp.json',
              integrity: 'sha256-example',
            },
          },
        },
      },
    }),
  )
  await assert.rejects(prepareGemmaImage({ baseImage, directory }))
  assert.equal(state.mkdir.mock.calls.length, 0)
})

test('does not remove a preexisting destination', async () => {
  state.mkdir.mockRejectedValue(new Error('example existing directory'))
  await assert.rejects(prepareGemmaImage({ baseImage, directory }))
  assert.equal(state.remove.mock.calls.length, 0)
})

test('cleans only its newly created context when a verified download fails', async () => {
  state.spawn
    .mockResolvedValueOnce({ stdout: 'local-context' })
    .mockRejectedValueOnce(new Error('example integrity mismatch'))
  await assert.rejects(prepareGemmaImage({ baseImage, directory }))
  assert.deepEqual(state.remove.mock.calls, [[directory]])
  assert.equal(state.cp.mock.calls.length, 0)
})

test('rejects a mutable build result and cleans the owned context', async () => {
  const original = state.readFile.getMockImplementation()!
  state.readFile.mockImplementation(async (file: string) =>
    file.endsWith('image-id') ? 'node:latest' : original(file),
  )
  await assert.rejects(prepareGemmaImage({ baseImage, directory }))
  assert.deepEqual(state.remove.mock.calls, [[directory]])
})

test('stops after a Docker build failure and removes only owned files', async () => {
  state.spawn
    .mockResolvedValueOnce({ stdout: 'local-context' })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error('example build failed'))
  await assert.rejects(prepareGemmaImage({ baseImage, directory }))
  assert.deepEqual(state.remove.mock.calls, [[directory]])
})

test('rejects an incomplete browser bundle before building the image', async () => {
  state.bundleGenerate.mockResolvedValue({
    output: [
      {
        type: 'chunk',
        code: '',
        imports: ['./missing.mjs'],
        dynamicImports: [],
      },
    ],
  })
  await assert.rejects(prepareGemmaImage({ baseImage, directory }))
  assert.equal(state.bundleClose.mock.calls.length, 1)
  assert.equal(state.spawn.mock.calls.length, 8)
  assert.deepEqual(state.remove.mock.calls, [[directory]])
})

test('uses a complete diagnostic stable package without replacing the production pin', async () => {
  const read = state.readFile.getMockImplementation()!
  state.readFile.mockImplementation(async (file: string) =>
    file === '/example/browser-pin.json'
      ? JSON.stringify({
          name: 'google-chrome-stable',
          version: '153.0.1.2-1',
          platforms: {
            'linux-x64': {
              asset: 'https://example.com/chrome-stable.deb',
              integrity: 'sha256-example',
            },
          },
        })
      : read(file),
  )
  const result = await prepareGemmaImage({
    baseImage,
    directory,
    browserPinFile: '/example/browser-pin.json',
  })
  assert.equal(result.browserPath, '/usr/bin/google-chrome-stable')
  assert.equal(
    state.spawn.mock.calls[1]?.[1][1],
    'https://example.com/chrome-stable.deb',
  )
  const files = new Map(
    state.writeFile.mock.calls.map(([file, content]) => [
      path.basename(file),
      content,
    ]),
  )
  assert.equal(files.get('browser-path'), '/usr/bin/google-chrome-stable\n')
  assert.equal(files.get('chrome-version'), '153.0.1.2\n')
  assert.ok(
    files
      .get('Dockerfile')
      .includes("roots: ['/opt/google/chrome', '/usr/lib/x86_64-linux-gnu']"),
  )
})

test('rejects unsupported diagnostic browser packages before downloads', async () => {
  const read = state.readFile.getMockImplementation()!
  state.readFile.mockImplementation(async (file: string) =>
    file === '/example/browser-pin.json'
      ? JSON.stringify({ name: 'example-browser', version: '153.0.1.2' })
      : read(file),
  )
  await assert.rejects(
    prepareGemmaImage({
      baseImage,
      directory,
      browserPinFile: '/example/browser-pin.json',
    }),
  )
  assert.equal(state.spawn.mock.calls.length, 0)
  assert.equal(state.mkdir.mock.calls.length, 0)
})
