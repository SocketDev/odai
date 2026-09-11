import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { collectGemmaCrashReports } from '../../../../../scripts/repo/cache/crash/collect.mts'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'

const REPORT_NAME = '12345678-1234-4234-8234-123456789012.dmp'
const roots: string[] = []

async function crashRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-crash-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  const results = await Promise.allSettled(
    roots.splice(0).map(root => safeDelete(root)),
  )
  for (const result of results) {
    expect(result.status).toBe('fulfilled')
  }
})

function validCrash(): Buffer {
  const bytes = Buffer.alloc(320)
  bytes.writeUInt32LE(0x50_4d_44_4d, 0)
  bytes.writeUInt32LE(0xa7_93, 4)
  bytes.writeUInt32LE(3, 8)
  bytes.writeUInt32LE(32, 12)
  for (const [index, values] of [
    [6, 168, 80],
    [7, 56, 248],
    [4, 4, 304],
  ].entries()) {
    for (const [field, value] of values.entries()) {
      bytes.writeUInt32LE(value, 32 + index * 12 + field * 4)
    }
  }
  bytes.writeUInt32LE(4, 88)
  bytes.writeUInt32LE(2, 92)
  bytes.writeUInt16LE(9, 248)
  bytes.writeUInt32LE(0x82_01, 268)
  return bytes
}

test('parses completed reports and deletes their bytes', async () => {
  const root = await crashRoot()
  const completed = path.join(root, 'completed')
  await fs.mkdir(completed)
  await fs.writeFile(path.join(completed, REPORT_NAME), validCrash())
  expect(await collectGemmaCrashReports(root)).toEqual({
    status: 'captured',
    databaseInitialized: true,
    reports: [
      {
        status: 'captured',
        exceptionCode: 4,
        exceptionFlags: 2,
        signal: 4,
        instruction: { status: 'unavailable' },
        diagnosis: {
          status: 'unavailable',
          mnemonic: undefined,
          module: undefined,
          moduleBuildId: undefined,
          imageModuleSha256: undefined,
          callChain: undefined,
          unwindStatus: 'unavailable',
          symbols: 'unavailable',
        },
      },
    ],
  })
  expect(await fs.readdir(completed)).toEqual([])
})

test('distinguishes an initialized empty database from missing database directories', async () => {
  const root = await crashRoot()
  expect(await collectGemmaCrashReports(root)).toEqual({
    status: 'unavailable',
    databaseInitialized: false,
    reports: [],
  })
  expect(await collectGemmaCrashReports(path.join(root, 'missing'))).toEqual({
    status: 'unavailable',
    databaseInitialized: false,
    reports: [],
  })
  await fs.mkdir(path.join(root, 'completed'))
  expect(await collectGemmaCrashReports(root)).toEqual({
    status: 'captured',
    databaseInitialized: true,
    reports: [],
  })
})

test('rejects relative, traversal and filesystem root inputs without deleting reports', async () => {
  const root = await crashRoot()
  await fs.mkdir(path.join(root, 'pending'))
  const file = path.join(root, 'pending', REPORT_NAME)
  await fs.writeFile(file, validCrash())
  for (const input of [
    path.relative(process.cwd(), root),
    `${root}/pending/..`,
    path.parse(root).root,
  ]) {
    expect(await collectGemmaCrashReports(input)).toEqual({
      status: 'unavailable',
      databaseInitialized: false,
      reports: [],
    })
  }
  expect(await fs.readFile(file)).toEqual(validCrash())
})

test('preserves report and directory symlinks without reading their targets', async () => {
  const root = await crashRoot()
  const outside = await crashRoot()
  const source = path.join(outside, REPORT_NAME)
  await fs.writeFile(source, validCrash())
  await fs.mkdir(path.join(root, 'pending'))
  const link = path.join(root, 'pending', REPORT_NAME)
  await fs.symlink(source, link)
  await fs.symlink(outside, path.join(root, 'completed'), 'junction')
  const open = vi.spyOn(fs, 'open')
  expect(await collectGemmaCrashReports(root)).toEqual({
    status: 'unavailable',
    databaseInitialized: true,
    reports: [],
  })
  expect(open).not.toHaveBeenCalled()
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
  expect(await fs.readFile(source)).toEqual(validCrash())
})

test('preserves a root symlink and rejects non-report names', async () => {
  const parent = await crashRoot()
  const root = await crashRoot()
  await fs.mkdir(path.join(root, 'pending'))
  const ignored = path.join(root, 'pending', 'private-report.dmp')
  await fs.writeFile(ignored, 'private data')
  const link = path.join(parent, 'linked-root')
  await fs.symlink(root, link, 'junction')
  expect((await collectGemmaCrashReports(link)).status).toBe('unavailable')
  expect(await collectGemmaCrashReports(root)).toEqual({
    status: 'captured',
    databaseInitialized: true,
    reports: [],
  })
  expect(await fs.readFile(ignored, 'utf8')).toBe('private data')
})

test('deletes oversized reports without reading them', async () => {
  const root = await crashRoot()
  await fs.mkdir(path.join(root, 'pending'))
  const file = path.join(root, 'pending', REPORT_NAME)
  await fs.writeFile(file, '')
  await fs.truncate(file, 16 * 1024 * 1024 + 1)
  expect(await collectGemmaCrashReports(root)).toEqual({
    status: 'captured',
    databaseInitialized: true,
    reports: [{ status: 'unavailable' }],
    truncated: true,
  })
  expect(await fs.readdir(path.join(root, 'pending'))).toEqual([])
})

test('caps retained reports while deleting later matching reports', async () => {
  const root = await crashRoot()
  const pending = path.join(root, 'pending')
  await fs.mkdir(pending)
  for (let index = 0; index < 6; index += 1) {
    await fs.writeFile(
      path.join(
        pending,
        REPORT_NAME.replace('12345678-', () => `1234567${index}-`),
      ),
      validCrash(),
    )
  }
  const result = await collectGemmaCrashReports(root)
  expect(result.status).toBe('captured')
  expect(result.reports).toHaveLength(4)
  expect(result.truncated).toBe(true)
  expect(await fs.readdir(pending)).toEqual([])
})

test('caps directory scanning without deleting unrelated files', async () => {
  const root = await crashRoot()
  const pending = path.join(root, 'pending')
  await fs.mkdir(pending)
  const results = await Promise.allSettled(
    Array.from({ length: 129 }, (...[, index]) =>
      fs.writeFile(path.join(pending, `metadata-${index}`), ''),
    ),
  )
  for (const result of results) {
    expect(result.status).toBe('fulfilled')
  }
  expect(await collectGemmaCrashReports(root)).toEqual({
    status: 'captured',
    databaseInitialized: true,
    reports: [],
    truncated: true,
  })
  expect(await fs.readdir(pending)).toHaveLength(129)
})

test('deletes encountered reports even if opening fails', async () => {
  const root = await crashRoot()
  const pending = path.join(root, 'pending')
  await fs.mkdir(pending)
  await fs.writeFile(path.join(pending, REPORT_NAME), validCrash())
  vi.spyOn(fs, 'open').mockRejectedValue(
    Object.assign(new Error('denied'), { code: 'EACCES' }),
  )
  expect(await collectGemmaCrashReports(root)).toEqual({
    status: 'unavailable',
    databaseInitialized: true,
    reports: [],
  })
  expect(await fs.readdir(pending)).toEqual([])
})

test('does not follow a symlink introduced between inspection and open', async () => {
  const root = await crashRoot()
  const outside = await crashRoot()
  const source = path.join(outside, REPORT_NAME)
  const pending = path.join(root, 'pending')
  await fs.mkdir(pending)
  const file = path.join(pending, REPORT_NAME)
  await fs.writeFile(source, validCrash())
  await fs.writeFile(file, validCrash())
  const open = fs.open.bind(fs)
  vi.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
    await safeDelete(file)
    await fs.symlink(source, file)
    return await open(filename, flags, mode)
  })
  expect(await collectGemmaCrashReports(root)).toEqual({
    status: 'unavailable',
    databaseInitialized: true,
    reports: [],
  })
  expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
  expect(await fs.readFile(source)).toEqual(validCrash())
})

test('reports cleanup failures without exposing filesystem errors', async () => {
  const root = await crashRoot()
  const pending = path.join(root, 'pending')
  await fs.mkdir(pending)
  await fs.writeFile(path.join(pending, REPORT_NAME), validCrash())
  vi.spyOn(fs, 'unlink').mockRejectedValue(
    Object.assign(new Error('private filename'), { code: 'EACCES' }),
  )
  const result = await collectGemmaCrashReports(root)
  expect(result.status).toBe('unavailable')
  expect(result.reports).toHaveLength(1)
  expect(JSON.stringify(result)).not.toContain('private filename')
})

test('deletes malformed reports and keeps raw names and bytes out of the result', async () => {
  const root = await crashRoot()
  const pending = path.join(root, 'pending')
  await fs.mkdir(pending)
  const file = path.join(pending, REPORT_NAME)
  await fs.writeFile(file, 'private report contents')
  const result = await collectGemmaCrashReports(root)
  expect(result).toEqual({
    status: 'captured',
    databaseInitialized: true,
    reports: [{ status: 'unavailable' }],
  })
  expect(await fs.readdir(pending)).toEqual([])
  expect(JSON.stringify(result)).not.toContain(REPORT_NAME)
  expect(JSON.stringify(result)).not.toContain('private report contents')
})

test('preserves reports only through an explicit option', async () => {
  const root = await crashRoot()
  const directory = path.join(root, 'pending')
  await fs.mkdir(directory)
  const file = path.join(directory, REPORT_NAME)
  await fs.writeFile(file, validCrash())
  const result = await collectGemmaCrashReports(root, { preserveReports: true })
  expect(result.status).toBe('captured')
  expect(await fs.readFile(file)).toEqual(validCrash())
})
