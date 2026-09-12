import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

import { auditGemmaArchive } from './archive.mts'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'

export async function splitGemmaArchive(
  archive: string,
  directory: string,
  options: { partBytes?: number | undefined } = {},
) {
  const partBytes = options.partBytes ?? 1_000_000_000
  if (!Number.isSafeInteger(partBytes) || partBytes < 1) {
    throw new Error(
      'Invalid archive part size. Expected a positive integer. Supply a valid byte limit.',
    )
  }
  const source = await fs.open(archive, 'r')
  const rows: string[] = []
  const files: string[] = []
  const buffer = Buffer.alloc(Math.min(partBytes, 1024 * 1024))
  try {
    let ended = false
    while (!ended) {
      const name = `part-${String(files.length).padStart(4, '0')}`
      const file = path.join(directory, name)
      const output = await fs.open(file, 'wx', 0o600)
      const hash = crypto.createHash('sha256')
      let size = 0
      try {
        while (size < partBytes) {
          const { bytesRead } = await source.read({
            buffer,
            offset: 0,
            length: Math.min(buffer.length, partBytes - size),
          })
          if (bytesRead === 0) {
            ended = true
            break
          }
          const bytes = buffer.subarray(0, bytesRead)
          await output.writeFile(bytes)
          hash.update(bytes)
          size += bytesRead
        }
      } finally {
        await output.close()
      }
      if (size === 0) {
        await safeDelete(file)
      } else {
        files.push(file)
        rows.push(`${hash.digest('hex')}  ${name}\n`)
      }
    }
  } finally {
    await source.close()
  }
  if (files.length === 0) {
    throw new Error(
      'Empty archive. Expected a nonempty Gemma archive. Rebuild the export.',
    )
  }
  const manifest = rows.join('')
  const manifestPath = path.join(directory, 'manifest.sha256')
  await fs.writeFile(manifestPath, manifest, { flag: 'wx', mode: 0o600 })
  return {
    __proto__: null,
    files: [...files, manifestPath],
    manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex'),
  }
}

export async function uploadGemmaArchive(archive: string, releaseTag: string) {
  if (!/^gemma-cache-[a-zA-Z0-9._-]+$/.test(releaseTag)) {
    throw new Error(
      'Invalid cache release tag. Expected gemma-cache- followed by a name. Supply a cache transport tag.',
    )
  }
  const audit = await auditGemmaArchive(archive)
  const state = await spawn(
    'gh',
    ['release', 'view', releaseTag, '--json', 'isDraft,assets'],
    {
      stdioString: true,
      timeout: 30_000,
    },
  )
  const release: unknown = JSON.parse(state.stdout)
  if (
    !release ||
    typeof release !== 'object' ||
    !('isDraft' in release) ||
    release.isDraft !== true ||
    !('assets' in release) ||
    !Array.isArray(release.assets) ||
    release.assets.length !== 0
  ) {
    throw new Error(
      'Cache upload destination is not empty. Expected an empty draft release. Create a dedicated draft before uploading.',
    )
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-upload-'))
  try {
    const parts = await splitGemmaArchive(archive, directory)
    await spawn('gh', ['release', 'upload', releaseTag, ...parts.files], {
      stdioString: true,
      timeout: 1_800_000,
    })
    return {
      __proto__: null,
      audit,
      releaseTag,
      manifestSha256: parts.manifestSha256,
    }
  } finally {
    await safeDelete(directory)
  }
}
