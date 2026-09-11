import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { afterEach, expect, test, vi } from 'vitest'
import { uploadArtifact } from '../../../../../scripts/fleet/artifact/client.mts'
import { uploadGemmaDiagnostics } from '../../../../../scripts/repo/cache/diagnostic/retain.mts'

vi.mock(import('../../../../../scripts/fleet/artifact/client.mts'), () => ({
  uploadArtifact: vi.fn().mockResolvedValue(42),
}))

const roots: string[] = []
const reportName = '12345678-1234-1234-1234-123456789abc.dmp'

async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'gemma-diagnostics-'),
  )
  roots.push(directory)
  const config = {
    directory,
    artifactName: 'gemma-diagnostics-12345-cpu',
    repositoryPrivate: true,
  }
  const metadata = path.join(directory, 'metadata.json')
  await fs.writeFile(metadata, '{"fixture":true}')
  return { config, metadata }
}

async function file(directory: string, relative: string, data = 'fixture') {
  const target = path.join(directory, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, data)
  return target
}

afterEach(async () => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) {
    await safeDelete(root)
  }
})

test('uploads approved diagnostics with seven-day retention and ignores Crashpad internals', async () => {
  const { config, metadata } = await fixture()
  const log = await file(
    config.directory,
    'native/gemma-native-abcdef/chrome.log',
  )
  const dump = await file(config.directory, `crashes/pending/${reportName}`)
  for (const relative of [
    'crashes/settings.dat',
    'crashes/pending/12345678-1234-1234-1234-123456789abc.meta',
    'crashes/attachments/private.txt',
    'crashes/new/other.dmp',
    'native/unrelated/chrome.log',
    'profile/History',
  ]) {
    await file(config.directory, relative, 'excluded fixture')
  }
  expect(await uploadGemmaDiagnostics(config)).toEqual({
    artifactId: 42,
    bytes: 30,
    dumpCount: 1,
    fileCount: 3,
  })
  expect(uploadArtifact).toHaveBeenCalledExactlyOnceWith(
    config.artifactName,
    [metadata, log, dump],
    { retentionDays: 7 },
  )
  expect(await fs.readFile(dump, 'utf8')).toBe('fixture')
})

test('allows metadata-only evidence when Chrome never initializes', async () => {
  const { config, metadata } = await fixture()
  expect(await uploadGemmaDiagnostics(config)).toMatchObject({
    dumpCount: 0,
    fileCount: 1,
  })
  expect(uploadArtifact).toHaveBeenCalledWith(config.artifactName, [metadata], {
    retentionDays: 7,
  })
})

test('allows a full native log alongside bounded context metadata', async () => {
  const { config, metadata } = await fixture()
  const log = await file(
    config.directory,
    'native/gemma-native-abcdef/chrome.log',
  )
  await fs.truncate(log, 1024 ** 2)
  await fs.truncate(metadata, 512 * 1024)
  expect(await uploadGemmaDiagnostics(config)).toMatchObject({
    bytes: 1536 * 1024,
    dumpCount: 0,
    fileCount: 2,
  })
})

test('rejects missing and linked bundle roots', async () => {
  const { config } = await fixture()
  const missing = path.join(config.directory, 'missing')
  await expect(
    uploadGemmaDiagnostics({ ...config, directory: missing }),
  ).rejects.toThrow()
  const linked = path.join(config.directory, 'linked')
  await fs.symlink(config.directory, linked)
  await expect(
    uploadGemmaDiagnostics({ ...config, directory: linked }),
  ).rejects.toThrow()
  expect(uploadArtifact).not.toHaveBeenCalled()
})

test('rejects hardlinked metadata', async () => {
  const { config, metadata } = await fixture()
  await fs.link(metadata, path.join(config.directory, 'metadata-copy'))
  await expect(uploadGemmaDiagnostics(config)).rejects.toThrow()
  expect(uploadArtifact).not.toHaveBeenCalled()
})

test.each([false, undefined, 'true'])(
  'refuses repository privacy value %s',
  async repositoryPrivate => {
    const { config } = await fixture()
    await expect(
      uploadGemmaDiagnostics({ ...config, repositoryPrivate }),
    ).rejects.toThrow()
    expect(uploadArtifact).not.toHaveBeenCalled()
  },
)

test.each(['relative', '/', '/tmp/../tmp'])(
  'rejects unsafe root %s',
  async directory => {
    const { config } = await fixture()
    await expect(
      uploadGemmaDiagnostics({ ...config, directory }),
    ).rejects.toThrow()
    expect(uploadArtifact).not.toHaveBeenCalled()
  },
)

test('requires the controlled artifact name and metadata file', async () => {
  const { config, metadata } = await fixture()
  await expect(
    uploadGemmaDiagnostics({ ...config, artifactName: 'profile' }),
  ).rejects.toThrow()
  await fs.rename(metadata, path.join(config.directory, 'other.json'))
  await expect(uploadGemmaDiagnostics(config)).rejects.toThrow()
  expect(uploadArtifact).not.toHaveBeenCalled()
})

test.each([
  'metadata.json',
  `crashes/pending/${reportName}`,
  'native/gemma-native-abcdef/chrome.log',
])('rejects linked selected file %s', async relative => {
  const { config } = await fixture()
  const target = await file(config.directory, relative)
  const original = `${target}.original`
  await fs.rename(target, original)
  await fs.symlink(original, target)
  await expect(uploadGemmaDiagnostics(config)).rejects.toThrow()
  expect(uploadArtifact).not.toHaveBeenCalled()
  expect(await fs.readFile(original, 'utf8')).toBe('fixture')
})

test.each([
  'native',
  'crashes',
  'crashes/pending',
  'native/gemma-native-abcdef',
])('rejects linked selected directory %s', async relative => {
  const { config } = await fixture()
  const target = path.join(config.directory, relative)
  const original = path.join(config.directory, 'linked-directory')
  await fs.mkdir(original)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.symlink(original, target)
  await expect(uploadGemmaDiagnostics(config)).rejects.toThrow()
  expect(uploadArtifact).not.toHaveBeenCalled()
})

test('rejects oversized dumps before calling the uploader', async () => {
  const { config } = await fixture()
  const target = await file(config.directory, `crashes/completed/${reportName}`)
  await fs.truncate(target, 16 * 1024 ** 2 + 1)
  await expect(uploadGemmaDiagnostics(config)).rejects.toThrow()
  expect(uploadArtifact).not.toHaveBeenCalled()
})

test('rejects more than four minidumps', async () => {
  const { config } = await fixture()
  for (let index = 0; index < 5; index += 1) {
    await file(
      config.directory,
      `crashes/pending/12345678-1234-1234-1234-123456789ab${index}.dmp`,
    )
  }
  await expect(uploadGemmaDiagnostics(config)).rejects.toThrow()
  expect(uploadArtifact).not.toHaveBeenCalled()
})

test('caps combined metadata and native log bytes', async () => {
  const { config } = await fixture()
  const log = await file(
    config.directory,
    'native/gemma-native-abcdef/chrome.log',
  )
  await fs.truncate(log, 2 * 1024 ** 2)
  await expect(uploadGemmaDiagnostics(config)).rejects.toThrow()
  expect(uploadArtifact).not.toHaveBeenCalled()
})

test('bounds directory enumeration even for excluded files', async () => {
  const { config } = await fixture()
  const directory = path.join(config.directory, 'crashes', 'pending')
  await fs.mkdir(directory, { recursive: true })
  for (let index = 0; index < 129; index += 1) {
    await fs.writeFile(path.join(directory, `excluded-${index}.meta`), '')
  }
  await expect(uploadGemmaDiagnostics(config)).rejects.toThrow()
  expect(uploadArtifact).not.toHaveBeenCalled()
})
