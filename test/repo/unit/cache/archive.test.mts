import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, test } from 'vitest'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'

import { auditGemmaArchive } from '../../../../scripts/repo/cache/archive.mts'

const roots: string[] = []

function tarEntry(name: string, type = '0', data = Buffer.alloc(0)) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write(
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
    148,
  )
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ])
}

function requiredEntries() {
  return [
    'image.tar',
    'image-id',
    'seccomp.json',
    'profile/odai-cache.html',
  ].map(name => tarEntry(name))
}

async function writeArchive(entries: Buffer[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-archive-'))
  roots.push(root)
  const archive = path.join(root, 'payload.tar.gz')
  await fs.writeFile(
    archive,
    gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])),
  )
  return archive
}

afterEach(async () => {
  const results = await Promise.allSettled(
    roots.splice(0).map(root => safeDelete(root)),
  )
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason
    }
  }
})

test('audits regular files without extracting them', async () => {
  const archive = await writeArchive(requiredEntries())
  await expect(auditGemmaArchive(archive)).resolves.toEqual({
    entryCount: 4,
    expandedBytes: 3072,
  })
  expect(await fs.readdir(path.dirname(archive))).toEqual(['payload.tar.gz'])
})

test.each([
  '._image.tar',
  'profile/._weights.bin',
  'profile/__MACOSX/weights.bin',
  'profile/.AppleDouble/weights.bin',
  '/profile/weights.bin',
  'profile/../weights.bin',
  'profile\\weights.bin',
  'profile/dir\\evil',
  'C:/profile/weights.bin',
  'unexpected.bin',
  'profile/./weights.bin',
])('rejects unsafe archive path %s', async name => {
  const archive = await writeArchive([...requiredEntries(), tarEntry(name)])
  await expect(auditGemmaArchive(archive)).rejects.toThrow()
})

test.each(['1', '2', '3', '4', '6'])(
  'rejects non-regular tar type %s',
  async type => {
    const archive = await writeArchive([
      ...requiredEntries(),
      tarEntry('profile/weights.bin', type),
    ])
    await expect(auditGemmaArchive(archive)).rejects.toThrow()
  },
)

test('rejects duplicates and missing required files', async () => {
  const duplicate = await writeArchive([
    ...requiredEntries(),
    tarEntry('./image.tar'),
  ])
  await expect(auditGemmaArchive(duplicate)).rejects.toThrow()
  const missing = await writeArchive([tarEntry('profile/weights.bin')])
  await expect(auditGemmaArchive(missing)).rejects.toThrow()
})

test('enforces entry and expanded-byte limits', async () => {
  const archive = await writeArchive(requiredEntries())
  await expect(auditGemmaArchive(archive, { maxEntries: 3 })).rejects.toThrow()
  await expect(auditGemmaArchive(archive, { maxBytes: 512 })).rejects.toThrow()
})

test('rejects corrupt compressed streams', async () => {
  const archive = await writeArchive(requiredEntries())
  await fs.writeFile(archive, 'not a gzip stream')
  await expect(auditGemmaArchive(archive)).rejects.toThrow()
})

test('validates the resolved PAX path', async () => {
  const value = 'path=profile/._weights.bin\n'
  const size = value.length + 3
  const pax = Buffer.from(`${size} ${value}`)
  const archive = await writeArchive([
    ...requiredEntries(),
    tarEntry('PaxHeader', 'x', pax),
    tarEntry('profile/weights.bin'),
  ])
  await expect(auditGemmaArchive(archive)).rejects.toThrow()
})

test('accepts portable PAX paths and directory headers', async () => {
  const value = 'path=profile/model-weights.bin\n'
  const pax = Buffer.from(`${value.length + 3} ${value}`)
  const archive = await writeArchive([
    tarEntry('profile/', '5'),
    ...requiredEntries(),
    tarEntry('PaxHeader', 'x', pax),
    tarEntry('profile/weights.bin'),
  ])
  await expect(auditGemmaArchive(archive)).resolves.toMatchObject({
    entryCount: 6,
  })
})

test('rejects invalid configured limits before reading the archive', async () => {
  const archive = await writeArchive(requiredEntries())
  await expect(auditGemmaArchive(archive, { maxBytes: -1 })).rejects.toThrow()
  await expect(
    auditGemmaArchive(archive, { maxEntries: NaN }),
  ).rejects.toThrow()
})
