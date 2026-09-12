/**
 * @file Build runner. Bundles the browser and Node entries with rolldown and
 *   emits TypeScript declarations with tsc.
 */

import { chmod } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

import { isMainModule } from '../fleet/process/is-main-module.mts'
import { runMain } from '../fleet/process/run-main.mts'

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
  await chmod(path.join(distPath, 'cli.js'), 0o755)
}

if (isMainModule(import.meta.url)) {
  runMain(main, {
    describe: 'Build the runtime bundles and their declaration dependencies.',
    help: 'Usage: pnpm run build',
  })
}
