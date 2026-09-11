import fs from 'node:fs/promises'
import path from 'node:path'
import { isErrnoException } from '@socketsecurity/lib-stable/errors/predicates'
import { uploadArtifact } from '../../../fleet/artifact/client.mts'

const MAX_DUMP_BYTES = 16 * 1024 ** 2
const MAX_TEXT_BYTES = 2 * 1024 ** 2
const MAX_ENTRIES = 128
const REPORT_NAME = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.dmp$/i

function diagnosticRetentionError(reason: string): Error {
  return new Error(
    `Gemma diagnostic retention failed. Where: private diagnostic bundle. Saw ${reason}; wanted bounded regular diagnostic files in private storage. Fix: use a closed dedicated probe directory in a private repository.`,
  )
}

export async function uploadGemmaDiagnostics(config: {
  artifactName: string
  directory: string
  repositoryPrivate: unknown
}): Promise<{
  artifactId: number
  bytes: number
  dumpCount: number
  fileCount: number
}> {
  const opts = { __proto__: null, ...config }
  if (
    opts.repositoryPrivate !== true ||
    !/^gemma-diagnostics-[a-zA-Z0-9._-]{1,120}$/.test(opts.artifactName) ||
    !path.isAbsolute(opts.directory) ||
    path.resolve(opts.directory) !== opts.directory ||
    path.parse(opts.directory).root === opts.directory
  ) {
    throw diagnosticRetentionError('invalid storage identity')
  }
  const files: string[] = []
  let dumpCount = 0
  let bytes = 0
  let textBytes = 0
  let entries = 0

  async function directoryExists(directory: string): Promise<boolean> {
    try {
      // oxlint-disable-next-line socket/prefer-exists-sync -- reject links
      const info = await fs.lstat(directory)
      if (!info.isDirectory()) {
        throw diagnosticRetentionError('a linked or invalid directory')
      }
      return true
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return false
      }
      throw error
    }
  }

  async function addFile(file: string, kind: 'dump' | 'text'): Promise<void> {
    // oxlint-disable-next-line socket/prefer-exists-sync -- type and size
    const info = await fs.lstat(file)
    if (!info.isFile() || info.nlink !== 1) {
      throw diagnosticRetentionError('a linked or nonregular file')
    }
    if (kind === 'dump') {
      dumpCount += 1
      if (dumpCount > 4 || info.size > MAX_DUMP_BYTES) {
        throw diagnosticRetentionError('minidumps exceeding the capture limit')
      }
    } else {
      textBytes += info.size
      if (textBytes > MAX_TEXT_BYTES) {
        throw diagnosticRetentionError(
          'diagnostic text exceeding the capture limit',
        )
      }
    }
    bytes += info.size
    files.push(file)
  }

  async function scan(
    directory: string,
    visit: (name: string) => Promise<void>,
  ): Promise<void> {
    if (!(await directoryExists(directory))) {
      return
    }
    for await (const entry of await fs.opendir(directory)) {
      if (++entries > MAX_ENTRIES) {
        throw diagnosticRetentionError('too many directory entries')
      }
      await visit(entry.name)
    }
  }

  try {
    if (!(await directoryExists(opts.directory))) {
      throw diagnosticRetentionError('a missing directory')
    }
    await addFile(path.join(opts.directory, 'metadata.json'), 'text')
    const nativeRoot = path.join(opts.directory, 'native')
    await scan(nativeRoot, async name => {
      if (!/^gemma-native-[a-zA-Z0-9_-]{6,64}$/.test(name)) {
        return
      }
      const directory = path.join(nativeRoot, name)
      if (await directoryExists(directory)) {
        await addFile(path.join(directory, 'chrome.log'), 'text')
      }
    })
    const crashRoot = path.join(opts.directory, 'crashes')
    if (await directoryExists(crashRoot)) {
      for (const name of ['pending', 'completed']) {
        const directory = path.join(crashRoot, name)
        await scan(directory, async report => {
          if (REPORT_NAME.test(report)) {
            await addFile(path.join(directory, report), 'dump')
          }
        })
      }
    }
  } catch {
    throw diagnosticRetentionError(
      'missing, unsafe or excessive diagnostic files',
    )
  }
  const artifactId = await uploadArtifact(opts.artifactName, files, {
    retentionDays: 7,
  })
  return { artifactId, bytes, dumpCount, fileCount: files.length }
}
