import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isErrnoException } from '@socketsecurity/lib-stable/errors/predicates'
import { decodeGemmaCrash } from './decode.mts'
import type { GemmaCrashDiagnostics } from '../crash.mts'
import type { Stats } from 'node:fs'

const MAX_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 128
const MAX_REPORTS = 4
const REPORT_NAME = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.dmp$/i

export interface GemmaCrashReports {
  status: 'captured' | 'unavailable'
  databaseInitialized: boolean
  reports: GemmaCrashDiagnostics[]
  truncated?: boolean | undefined
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    right.nlink === 1 &&
    left.dev === right.dev &&
    left.ino === right.ino
  )
}

async function readReport(
  handle: fs.FileHandle,
  size: number,
): Promise<GemmaCrashDiagnostics> {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      size - offset,
      offset,
    )
    if (!bytesRead) {
      return { status: 'unavailable' }
    }
    offset += bytesRead
  }
  // oxlint-disable-next-line socket/prefer-exists-sync -- metadata
  if ((await handle.stat()).size !== size) {
    return { status: 'unavailable' }
  }
  return await decodeGemmaCrash(buffer)
}

async function collectReport(
  file: string,
  config: { retain: boolean; preserveReports?: boolean | undefined },
): Promise<{
  report?: GemmaCrashDiagnostics | undefined
  failed: boolean
  truncated: boolean
}> {
  const opts = { __proto__: null, ...config }
  const retain = opts.retain
  const result: {
    report?: GemmaCrashDiagnostics | undefined
    failed: boolean
    truncated: boolean
  } = {
    failed: false,
    truncated: !retain,
  }
  // oxlint-disable-next-line socket/prefer-exists-sync -- identity
  const before = await fs.lstat(file)
  if (!before.isFile() || before.nlink !== 1) {
    return { failed: true, truncated: false }
  }
  try {
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      // oxlint-disable-next-line socket/prefer-exists-sync -- metadata
      const current = await handle.stat()
      if (!sameFile(before, current)) {
        result.failed = true
      } else if (retain) {
        if (current.size > MAX_BYTES) {
          result.report = { status: 'unavailable' }
          result.truncated = true
        } else {
          result.report = await readReport(handle, current.size)
        }
      }
    } finally {
      await handle.close()
    }
  } catch {
    result.failed = true
  } finally {
    try {
      // oxlint-disable-next-line socket/prefer-exists-sync -- identity
      if (sameFile(before, await fs.lstat(file))) {
        if (!opts.preserveReports) {
          // oxlint-disable-next-line socket/prefer-safe-delete -- literal
          await fs.unlink(file)
        }
      } else {
        result.failed = true
      }
    } catch {
      result.failed = true
    }
  }
  return result
}

async function collectDirectory(
  directory: string,
  result: GemmaCrashReports,
  budget: {
    remaining: number
    reports: number
    preserveReports?: boolean | undefined
  },
): Promise<void> {
  let metadata: Stats
  try {
    // oxlint-disable-next-line socket/prefer-exists-sync -- file type
    metadata = await fs.lstat(directory)
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return
    }
    throw error
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    result.status = 'unavailable'
    return
  }
  result.databaseInitialized = true
  const directoryHandle = await fs.opendir(directory, { bufferSize: 8 })
  try {
    for (;;) {
      const entry = await directoryHandle.read()
      if (!entry) {
        break
      }
      if (budget.remaining === 0) {
        result.truncated = true
        break
      }
      budget.remaining -= 1
      if (!REPORT_NAME.test(entry.name)) {
        continue
      }
      const retain = budget.reports > 0
      if (retain) {
        budget.reports -= 1
      }
      const captured = await collectReport(path.join(directory, entry.name), {
        retain,
        preserveReports: budget.preserveReports,
      })
      if (captured.report) {
        result.reports.push(captured.report)
      }
      if (captured.failed) {
        result.status = 'unavailable'
      }
      if (captured.truncated) {
        result.truncated = true
      }
    }
  } finally {
    await directoryHandle.close()
  }
}

export async function collectGemmaCrashReports(
  root: string,
  options: { preserveReports?: boolean | undefined } = {},
): Promise<GemmaCrashReports> {
  const result: GemmaCrashReports = {
    status: 'unavailable',
    databaseInitialized: false,
    reports: [],
  }
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    root === path.parse(root).root
  ) {
    return result
  }
  try {
    // oxlint-disable-next-line socket/prefer-exists-sync -- file type
    const metadata = await fs.lstat(root)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return result
    }
    result.status = 'captured'
    const budget = {
      remaining: MAX_ENTRIES,
      reports: MAX_REPORTS,
      preserveReports: options.preserveReports,
    }
    await collectDirectory(path.join(root, 'pending'), result, budget)
    await collectDirectory(path.join(root, 'completed'), result, budget)
    if (!result.databaseInitialized) {
      result.status = 'unavailable'
    }
  } catch {
    result.status = 'unavailable'
  }
  return result
}
