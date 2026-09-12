import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'

async function hashElf(file: string): Promise<string | undefined> {
  const handle = await fs.open(file, 'r')
  try {
    // oxlint-disable-next-line socket/prefer-exists-sync -- metadata
    if ((await handle.stat()).size > 1024 * 1024 * 1024) {
      throw new RangeError('ELF exceeds inventory size limit')
    }
    const magic = Buffer.alloc(4)
    await handle.read(magic, 0, 4, 0)
    if (!magic.equals(Buffer.from([127, 69, 76, 70]))) {
      return undefined
    }
    const hash = crypto.createHash('sha256')
    for await (const part of handle.createReadStream({
      start: 0,
      autoClose: false,
      highWaterMark: 65_536,
    })) {
      hash.update(part)
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function inventoryEntry(
  root: string,
  entry: Dirent,
): Promise<string | undefined> {
  if (
    (!entry.isFile() && !entry.isSymbolicLink()) ||
    !/^[a-zA-Z0-9_.+-]{1,128}$/.test(entry.name)
  ) {
    return undefined
  }
  const file = await fs.realpath(path.join(root, entry.name))
  const relative = path.relative(root, file)
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined
  }
  // oxlint-disable-next-line socket/prefer-exists-sync -- metadata
  if (!(await fs.stat(file)).isFile()) {
    return undefined
  }
  return await hashElf(file)
}

export async function buildGemmaModuleInventory(
  options: { roots?: string[] | undefined; output?: string | undefined } = {},
) {
  const roots = options.roots ?? [
    '/opt/google/chrome-beta',
    '/usr/lib/x86_64-linux-gnu',
  ]
  const output = options.output ?? '/opt/odai-cache/native-modules.json'
  if (
    roots.length > 8 ||
    !path.isAbsolute(output) ||
    roots.some(root => !path.isAbsolute(root))
  ) {
    throw new RangeError('Invalid inventory paths')
  }
  const inventory = new Map<string, string | false>()
  for (const root of roots) {
    const canonicalRoot = await fs.realpath(root)
    const directory = await fs.opendir(canonicalRoot)
    let count = 0
    for await (const entry of directory) {
      count += 1
      if (count > 4096) {
        throw new RangeError('Inventory exceeds entry limit')
      }
      const hash = await inventoryEntry(canonicalRoot, entry)
      if (hash) {
        inventory.set(
          entry.name,
          inventory.has(entry.name) && inventory.get(entry.name) !== hash
            ? false
            : hash,
        )
      }
    }
  }
  await fs.writeFile(output, JSON.stringify(Object.fromEntries(inventory)), {
    mode: 0o600,
  })
}
