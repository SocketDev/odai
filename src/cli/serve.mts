import { errorMessage } from '@socketsecurity/lib/errors/message'

import { startShimServer } from '../shim/server.mts'
import type { ShimServerHandle } from '../shim/server.mts'
import type { OdaiBackend } from '../backends/types.mts'
import { closeBackend, EXIT_OK, EXIT_TASK_FAILURE } from './runtime.mts'
import type { LineWriter } from './runtime.mts'

export interface RunServeCommandOptions {
  /**
   * Called once the shim is listening; the test injection point for learning
   * the bound port.
   */
  onStart?: ((handle: ShimServerHandle) => void) | undefined
  /**
   * Resolves when the server should shut down. Defaults to SIGINT/SIGTERM.
   */
  stop?: Promise<void> | undefined
}

/**
 * The serve lifecycle: bring the loopback shim up over the selected
 * backend, print the client connection hint, and hold until the stop signal.
 * The shim handle's close also closes the backend.
 */
export async function runServeCommand(
  backend: OdaiBackend,
  port: number,
  stderr: LineWriter,
  options?: RunServeCommandOptions | undefined,
): Promise<number> {
  const opts = { __proto__: null, ...options } as RunServeCommandOptions
  let handle: ShimServerHandle
  try {
    handle = await startShimServer({
      backend,
      log: stderr,
      port,
    })
  } catch (error) {
    stderr(
      `odai serve: ${errorMessage(error)} — pass --port <n> for a different ` +
        'port or --port 0 for an OS-assigned one.',
    )
    await closeBackend(backend)
    return EXIT_TASK_FAILURE
  }
  opts.onStart?.(handle)
  stderr(
    `ANTHROPIC_BASE_URL=${handle.url} ANTHROPIC_API_KEY=<any non-empty value>`,
  )
  stderr(
    `OPENAI_BASE_URL=${handle.url}/v1 OPENAI_API_KEY=<any non-empty ` +
      'value> — Ctrl-C stops.',
  )
  const stop =
    opts.stop ??
    /* c8 ignore start - process signal wait; the bin entry's real stop path,
       covered in-process through the injected opts.stop instead */
    new Promise<void>(resolve => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  /* c8 ignore stop */
  await stop
  await handle.close()
  return EXIT_OK
}
