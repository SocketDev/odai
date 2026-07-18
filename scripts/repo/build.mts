/**
 * @file Build runner. Bundles the browser and Node entries with rolldown and
 *   emits TypeScript declarations with tsc.
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

const logger = getDefaultLogger()
const rootPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)
const distPath = path.join(rootPath, 'dist')

async function run(command: string, args: string[]): Promise<number> {
  try {
    await spawn(command, args, { cwd: rootPath, stdio: 'inherit' })
    return 0
  } catch {
    return 1
  }
}

async function main(): Promise<void> {
  await safeDelete(distPath)

  let exitCode = await run('rolldown', [
    '--config',
    '.config/repo/rolldown.config.mts',
  ])
  if (exitCode !== 0) {
    logger.error('Source bundle failed')
    process.exitCode = exitCode
    return
  }

  exitCode = await run('tsc', ['--project', 'tsconfig.dts.json'])
  if (exitCode !== 0) {
    logger.error('Type declarations failed')
    process.exitCode = exitCode
    return
  }

  await removeInternalDeclarations(distPath)
}

const PUBLIC_DECLARATION_FILES = new Set([
  'gnh/index.d.mts',
  'index.d.mts',
  'node.d.mts',
])

async function removeInternalDeclarations(dir: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.d.mts')) {
      continue
    }
    if (PUBLIC_DECLARATION_FILES.has(entry.name)) {
      continue
    }
    await safeDelete(path.join(entry.parentPath, entry.name))
  }
}

main().catch(error => {
  logger.error(error)
  process.exitCode = 1
})
