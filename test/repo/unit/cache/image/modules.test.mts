import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { buildGemmaModuleInventory } from '../../../../../scripts/repo/cache/image/modules.mts'

test('hashes only bounded in-root ELF files and rejects ambiguous basenames', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-inventory-'))
  try {
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    const output = path.join(root, 'inventory.json')
    await fs.mkdir(first)
    await fs.mkdir(second)
    const bytes = Buffer.from([127, 69, 76, 70, 1, 2])
    await fs.writeFile(path.join(first, 'chrome'), bytes)
    await fs.writeFile(path.join(first, 'plain.txt'), 'example')
    await fs.writeFile(path.join(first, 'shared.so'), bytes)
    await fs.writeFile(
      path.join(second, 'shared.so'),
      Buffer.from([127, 69, 76, 70, 3]),
    )
    await fs.symlink(
      path.join(first, 'chrome'),
      path.join(first, 'chrome-alias'),
    )
    await fs.symlink(
      path.join(second, 'shared.so'),
      path.join(first, 'outside.so'),
    )
    await buildGemmaModuleInventory({ roots: [first, second], output })
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    expect(JSON.parse(await fs.readFile(output, 'utf8'))).toEqual({
      chrome: hash,
      'chrome-alias': hash,
      'shared.so': false,
    })
  } finally {
    await safeDelete(root)
  }
})
test('rejects relative destinations before creating files', async () => {
  await expect(
    buildGemmaModuleInventory({ roots: [], output: 'relative.json' }),
  ).rejects.toBeInstanceOf(RangeError)
})
