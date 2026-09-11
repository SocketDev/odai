import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { isMainModule } from '../../../fleet/process/is-main-module.mts'
import { getCacheArgs, runCacheMain } from '../cli.mts'
import type { CacheScriptMeta } from '../cli.mts'
import { collectGemmaCrashReports } from '../crash/collect.mts'
import { parseGemmaKernelFaults } from '../kernel.mts'
import { verifyGemmaReplay } from '../retain.mts'

const MAX_KERNEL_BYTES = 1024 ** 2

function diagnosticError(reason: string): Error {
  return new Error(
    `Odai diagnosis failed. Where: local diagnostic input. Saw ${reason}; wanted readable, bounded evidence. Fix: use --help and supply the original diagnostic files.`,
  )
}

function requiredArgument(value: string | undefined): string {
  if (!value) {
    throw diagnosticError('a missing argument')
  }
  return value
}

async function readKernelInput(filename: string): Promise<string> {
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    // oxlint-disable-next-line socket/prefer-exists-sync -- metadata
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_KERNEL_BYTES) {
      throw diagnosticError('an invalid kernel file')
    }
    const buffer = Buffer.alloc(MAX_KERNEL_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      )
      if (!bytesRead) {
        break
      }
      offset += bytesRead
    }
    if (offset > MAX_KERNEL_BYTES) {
      throw diagnosticError('an oversized kernel file')
    }
    return buffer.toString('utf8', 0, offset)
  } finally {
    await handle.close()
  }
}

async function diagnoseCrashes(directory: string) {
  const data = await collectGemmaCrashReports(path.resolve(directory), {
    preserveReports: true,
  })
  const complete =
    data.status === 'captured' &&
    !data.truncated &&
    data.reports.length > 0 &&
    data.reports.every(report => report.status === 'captured')
  return { __proto__: null, exitCode: complete ? 0 : 1, data }
}

export async function main(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'browser-version': { type: 'string' },
      'cpu-override': { type: 'boolean' },
      directory: { type: 'string' },
      file: { type: 'string' },
      'image-digest': { type: 'string' },
      since: { type: 'string' },
      'source-run': { type: 'string' },
    },
    strict: true,
  })
  const command = positionals[0]
  if (
    positionals.length !== 1 ||
    !['crashes', 'kernel', 'replay'].includes(command ?? '')
  ) {
    throw diagnosticError('an unknown command')
  }
  if (command === 'crashes') {
    return await diagnoseCrashes(requiredArgument(values.directory))
  }
  if (command === 'kernel') {
    const since = Number(requiredArgument(values.since))
    if (!Number.isFinite(since) || since < 0) {
      throw diagnosticError('an invalid --since value')
    }
    let input: string
    try {
      input = await readKernelInput(requiredArgument(values.file))
    } catch {
      throw diagnosticError('an unreadable or oversized kernel file')
    }
    const data = parseGemmaKernelFaults(input, since)
    return {
      __proto__: null,
      exitCode: data.status === 'captured' && !data.truncated ? 0 : 1,
      data,
    }
  }
  try {
    const data = await verifyGemmaReplay({
      browserVersion: requiredArgument(values['browser-version']),
      cpuOverride: values['cpu-override'] ?? false,
      directory: path.resolve(requiredArgument(values.directory)),
      imageDigest: requiredArgument(values['image-digest']),
      sourceRun: requiredArgument(values['source-run']),
    })
    return { __proto__: null, exitCode: 0, data }
  } catch {
    throw diagnosticError('missing, expired or mismatched replay evidence')
  }
}

const SCRIPT_META: CacheScriptMeta = {
  describe: 'inspects retained Gemma crash, kernel and replay evidence locally',
  help: 'Usage: pnpm run ai:odai:diagnose <crashes|kernel|replay> [options]\ncrashes --directory <crashpad-directory> Inspect pending and completed reports without deleting them\nkernel --file <dmesg-json> --since <uptime-seconds> Inspect bounded dmesg --json output after the probe start\nreplay --directory <artifact-directory> --browser-version <version> --image-digest <sha256:digest> --source-run <run-id> [--cpu-override] Verify retained hashes and source identity\n--json Emit sanitized evidence; no raw dumps, addresses or kernel messages\nSuccessful inspection is not an inference pass. Missing crash evidence, unavailable collection or truncation exits nonzero. An empty captured kernel event list means no matching events. Replay verification does not run inference.\nUse pnpm run ai:odai:cache verify for sandboxed inference without networking.',
  json: 'result',
}

if (isMainModule(import.meta.url)) {
  runCacheMain(() => main(getCacheArgs()), SCRIPT_META)
}
