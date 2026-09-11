import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  splitGemmaArchive,
  uploadGemmaArchive,
} from '../../../../scripts/repo/cache/upload.mts'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'

const mocks = vi.hoisted(() => ({ audit: vi.fn(), spawn: vi.fn() }))
vi.mock(import('../../../../scripts/repo/cache/archive.mts'), () => ({
  auditGemmaArchive: mocks.audit,
}))
vi.mock(
  import('@socketsecurity/lib-stable/process/spawn/child'),
  async original => ({ ...(await original()), spawn: mocks.spawn }),
)

let directory: string
let archive: string

beforeEach(async () => {
  vi.resetAllMocks()
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-upload-test-'))
  archive = path.join(directory, 'example.tar.gz')
  await fs.writeFile(archive, 'example archive')
  mocks.audit.mockResolvedValue({ entries: 4 })
  mocks.spawn.mockResolvedValue({
    stdout: JSON.stringify({ isDraft: true, assets: [] }),
    code: 0,
  })
})
afterEach(async () => {
  await safeDelete(directory)
})

test('parts reconstruct the archive and each checksum covers the actual bytes', async () => {
  const result = await splitGemmaArchive(archive, directory, { partBytes: 3 })
  const manifest = await fs.readFile(result.files.at(-1)!, 'utf8')
  const chunks: Buffer[] = []
  const rows = manifest.trim().split(/\r?\n/)
  for (let index = 0, length = rows.length; index < length; index++) {
    const row = rows[index]!
    const { 0: digest, 1: name } = row.split('  ')
    const bytes = await fs.readFile(path.join(directory, name!))
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(digest)
    chunks.push(bytes)
  }
  expect(Buffer.concat(chunks)).toEqual(await fs.readFile(archive))
  expect(result.manifestSha256).toBe(
    crypto.createHash('sha256').update(manifest).digest('hex'),
  )
})

test.each([0, -1, 1.5, NaN])('rejects invalid part size %s', async size => {
  await expect(
    splitGemmaArchive(archive, directory, { partBytes: size }),
  ).rejects.toThrow()
})

test('rejects an empty input', async () => {
  await fs.writeFile(archive, '')
  await expect(splitGemmaArchive(archive, directory)).rejects.toThrow()
})

test('archive rejection prevents every remote operation', async () => {
  mocks.audit.mockRejectedValue(new Error('Rejected archive'))
  await expect(
    uploadGemmaArchive(archive, 'gemma-cache-example'),
  ).rejects.toThrow()
  expect(mocks.spawn).not.toHaveBeenCalled()
})

test.each([
  { isDraft: false, assets: [] },
  { isDraft: true, assets: [{ name: 'existing' }] },
  undefined,
])('rejects an unsuitable destination', async state => {
  mocks.spawn.mockResolvedValue({ stdout: JSON.stringify(state), code: 0 })
  await expect(
    uploadGemmaArchive(archive, 'gemma-cache-example'),
  ).rejects.toThrow()
  expect(mocks.spawn).toHaveBeenCalledTimes(1)
})

test('uploads audited bytes and cleans temporary parts after a remote failure', async () => {
  let part = ''
  mocks.spawn.mockImplementation(async (...[, args]) => {
    if (args[1] === 'view') {
      return { stdout: JSON.stringify({ isDraft: true, assets: [] }), code: 0 }
    }
    part = args[3]
    expect(await fs.readFile(part)).toEqual(await fs.readFile(archive))
    throw new Error('Upload failed')
  })
  await expect(
    uploadGemmaArchive(archive, 'gemma-cache-example'),
  ).rejects.toThrow()
  expect(mocks.audit).toHaveBeenCalledWith(archive)
  expect(existsSync(part)).toBe(false)
})

test('returns the manifest pin after uploading', async () => {
  const result = await uploadGemmaArchive(archive, 'gemma-cache-example')
  expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.releaseTag).toBe('gemma-cache-example')
})

test('invalid tag prevents audit and upload', async () => {
  await expect(uploadGemmaArchive(archive, '--example')).rejects.toThrow()
  expect(mocks.audit).not.toHaveBeenCalled()
  expect(mocks.spawn).not.toHaveBeenCalled()
})
