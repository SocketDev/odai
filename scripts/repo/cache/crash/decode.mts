import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { isObject } from '@socketsecurity/lib-stable/objects/predicates'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseGemmaCrash, readGemmaCrashDetails } from '../crash.mts'

const executeDecoder = promisify(execFile)
const DECODER = '/opt/odai-cache/decoder/usr/bin/x86_64-linux-gnu-objdump'
const PREFIXES = new Set([
  'addr32',
  'bnd',
  'cs',
  'data16',
  'ds',
  'es',
  'fs',
  'gs',
  'lock',
  'notrack',
  'rep',
  'repe',
  'repne',
  'repnz',
  'repz',
  'rex',
  'rex.W',
  'ss',
])

export function parseGemmaDisassembly(output: string): string | undefined {
  if (output.length > 8192) {
    return undefined
  }
  const match = /^\s*0:\s+([^\r\n]+)$/m.exec(output)
  if (!match) {
    return undefined
  }
  const tokens = match[1]!.trim().split(/\s+/)
  const result: string[] = []
  for (
    let index = 0, tokenCount = tokens.length;
    index < tokenCount;
    index += 1
  ) {
    const token = tokens[index]!
    if (result.length >= 8) {
      return undefined
    }
    if (PREFIXES.has(token)) {
      result.push(token)
      continue
    }
    if (!/^[a-z][a-z0-9]{1,31}$/.test(token)) {
      return undefined
    }
    result.push(token)
    return result.join(' ')
  }
  return undefined
}

async function moduleInventory(): Promise<Map<string, string>> {
  const file = await fs.open('/opt/odai-cache/native-modules.json', 'r')
  try {
    // oxlint-disable-next-line socket/prefer-exists-sync -- metadata
    if ((await file.stat()).size > 1024 * 1024) {
      return new Map()
    }
    const parsed: unknown = JSON.parse(await file.readFile('utf8'))
    if (!isObject(parsed)) {
      return new Map()
    }
    const result = new Map<string, string>()
    const entries = Object.entries(parsed)
    for (
      let index = 0, entryCount = entries.length;
      index < entryCount;
      index += 1
    ) {
      const { 0: name, 1: hash } = entries[index]!
      if (
        /^[a-zA-Z0-9_.+-]{1,128}$/.test(name) &&
        typeof hash === 'string' &&
        /^[a-f0-9]{64}$/.test(hash)
      ) {
        result.set(name, hash)
      }
    }
    return result
  } finally {
    await file.close()
  }
}

function safeModule(
  identity: {
    module: string
    moduleName: string
    buildId?: string | undefined
  },
  inventory: Map<string, string>,
) {
  const sha = inventory.get(identity.moduleName)
  const result = {
    __proto__: null,
    module: sha ? identity.moduleName : identity.module,
    ...(identity.buildId ? { buildId: identity.buildId } : {}),
    ...(sha ? { imageModuleSha256: sha } : {}),
  }
  return result
}

export async function decodeGemmaCrash(
  input: Uint8Array,
  options: {
    execute?:
      | ((
          file: string,
          args: string[],
          config: {
            timeout: number
            maxBuffer: number
            encoding: 'utf8'
            env: { LD_LIBRARY_PATH: string }
          },
        ) => Promise<{ stdout: string; stderr: string }>)
      | undefined
  } = {},
) {
  const parsed = parseGemmaCrash(input)
  if (parsed.status !== 'captured') {
    return parsed
  }
  const details = readGemmaCrashDetails(input)
  const diagnosis = {
    status: 'unavailable' as 'captured' | 'unavailable',
    mnemonic: undefined as string | undefined,
    module: details?.module,
    moduleBuildId: details?.moduleBuildId,
    imageModuleSha256: undefined as string | undefined,
    callChain: details?.callChain.map(identity =>
      safeModule(identity, new Map()),
    ),
    unwindStatus: details?.unwindStatus ?? 'unavailable',
    symbols: 'unavailable' as const,
  }
  let directory: string | undefined
  try {
    if (!details?.instructionBytes.length) {
      return { __proto__: null, ...parsed, diagnosis }
    }
    const inventory = await moduleInventory().catch(
      () => new Map<string, string>(),
    )
    const identity = safeModule(
      {
        module: details.module,
        moduleName: details.moduleName,
        buildId: details.moduleBuildId,
      },
      inventory,
    )
    diagnosis.module = identity.module
    diagnosis.imageModuleSha256 = identity.imageModuleSha256
    diagnosis.callChain = details.callChain.map(frame =>
      safeModule(frame, inventory),
    )
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-decode-'))
    await fs.chmod(directory, 0o700)
    const file = path.join(directory, 'instruction.bin')
    await fs.writeFile(file, details.instructionBytes, { mode: 0o600 })
    const result = await (options.execute ?? executeDecoder)(
      DECODER,
      [
        '-D',
        '-b',
        'binary',
        '-m',
        'i386:x86-64',
        '--no-show-raw-insn',
        '--insn-width=16',
        '--',
        file,
      ],
      {
        timeout: 5000,
        encoding: 'utf8',
        maxBuffer: 8192,
        env: {
          LD_LIBRARY_PATH: '/opt/odai-cache/decoder/usr/lib/x86_64-linux-gnu',
        },
      },
    )
    const mnemonic = parseGemmaDisassembly(result.stdout)
    if (mnemonic) {
      diagnosis.mnemonic = mnemonic
      diagnosis.status = 'captured'
    }
  } catch {
    diagnosis.status = 'unavailable'
  } finally {
    if (directory) {
      await safeDelete(directory).catch(() => undefined)
    }
  }
  const result = { __proto__: null, ...parsed, diagnosis }
  return result
}
