/**
 * @file Odai bin entry. Parses argv, runs the CLI core, and exits with its
 *   code. The explicit process.exit is deliberate: the headless-Chrome bridge
 *   holds a live child process, and a finished CLI must never linger on open
 *   handles.
 */

import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

import { runCli } from './cli/run.mts'

const logger = getDefaultLogger()

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2))
  process.exit(code)
}

main().catch((error: unknown) => {
  logger.fail(error)
  process.exit(1)
})
