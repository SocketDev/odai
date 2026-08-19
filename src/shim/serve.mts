/**
 * @file Shim serve entry. Starts the loopback shim and stays up
 *   until interrupted. Run it directly:
 *   `node --experimental-strip-types src/shim/serve.mts --port 8402`.
 *   Backend selection follows the registry: `--backend <name>` wins, then
 *   ODAI_BACKEND, then the availability probe. Point an Anthropic client at
 *   the printed URL with ANTHROPIC_BASE_URL, or an OpenAI client at the same
 *   URL's `/v1` prefix with OPENAI_BASE_URL, either with any non-empty
 *   placeholder key.
 */

import { errorMessage } from '@socketsecurity/lib/errors/message'
import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

import { isBackendName } from '../backends/registry.mts'
import { isMainModule } from '../is-main-module.mts'
import { startShimServer } from './server.mts'
import type { BackendName } from '../backends/types.mts'

const DEFAULT_PORT = 8402
const MAX_PORT = 65_535

const logger = getDefaultLogger()

export function parseServeArgs(argv: string[]): {
  backendName: BackendName | undefined
  port: number
} {
  let backendName: BackendName | undefined
  let port = DEFAULT_PORT
  for (let i = 0, { length } = argv; i < length; i += 1) {
    const token = argv[i]!
    if (token === '--port') {
      i += 1
      const value = Number(argv[i])
      if (!Number.isInteger(value) || value < 0 || value > MAX_PORT) {
        throw new Error(`--port ${argv[i]} is not a valid port.`)
      }
      port = value
    } else if (token === '--backend') {
      i += 1
      const value = argv[i]
      if (value === undefined || !isBackendName(value)) {
        throw new Error(`--backend ${value} is not a declared backend.`)
      }
      backendName = value
    } else {
      throw new Error(`unknown option ${token}.`)
    }
  }
  return { backendName, port }
}

/* c8 ignore start - module entrypoint; exercised via subprocess */
async function main(): Promise<void> {
  const { backendName, port } = parseServeArgs(process.argv.slice(2))
  const handle = await startShimServer({
    ...(backendName === undefined ? {} : { backendName }),
    log: line => logger.error(line),
    port,
  })
  logger.error(
    `ANTHROPIC_BASE_URL=${handle.url} ANTHROPIC_API_KEY=<any non-empty value>`,
  )
  logger.error(
    `OPENAI_BASE_URL=${handle.url}/v1 OPENAI_API_KEY=<any non-empty ` +
      'value> — Ctrl-C stops.',
  )
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  await handle.close()
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.error(errorMessage(error))
    process.exitCode = 1
  })
}
/* c8 ignore stop */
