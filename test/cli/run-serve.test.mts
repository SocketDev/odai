import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import { createSimulatorBackend } from '../../src/backends/simulator.mts'
import { runCli } from '../../src/cli/run.mts'
import { tolerantSleep } from '../fleet/_shared/lib/timing.mts'
import type { OdaiBackend } from '../../src/backends/types.mts'

interface Capture {
  lines: string[]
  text: () => string
  write: (line: string) => void
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

interface ServeHandle {
  url: string
}

function createCapture(): Capture {
  const lines: string[] = []
  return {
    lines,
    text: () => lines.join('\n'),
    write: (line: string) => {
      lines.push(line)
    },
  }
}

function createDeferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function createUnavailableBackend(reason: string): OdaiBackend {
  return {
    async availability() {
      return { available: false, reason }
    },
    async languageModel() {
      throw new Error('unavailable backend has no language model')
    },
    name: 'llama-server',
  }
}

async function untilListening(
  get: () => ServeHandle | undefined,
): Promise<ServeHandle> {
  for (let i = 0; i < 100; i += 1) {
    const value = get()
    if (value !== undefined) {
      return value
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, tolerantSleep(10))
    })
  }
  throw new Error('the serve command never reported a listening shim.')
}

describe('odai serve', () => {
  it('exits 69 with provisioning help when no backend is available', async () => {
    const stderr = createCapture()
    const code = await runCli(['serve'], {
      backend: createUnavailableBackend('engine offline'),
      env: {},
      stderr: stderr.write,
    })
    expect(code).toBe(69)
    expect(stderr.text()).toContain('no usable backend')
    expect(stderr.text()).toContain('engine offline')
    expect(stderr.text()).toContain('Provisioning:')
  })

  it('serves Anthropic Messages requests until stopped', async () => {
    const backend = createSimulatorBackend({
      fallback:
        '{"tool_call": {"name": "read_file", "input": {"path": "README.md"}}}',
      rules: [],
    })
    const stderr = createCapture()
    const stop = createDeferred()
    let handle: ServeHandle | undefined
    const codePromise = runCli(['serve', '--port', '0'], {
      backend,
      env: {},
      onServeStart: started => {
        handle = started
      },
      stderr: stderr.write,
      stopServing: stop.promise,
    })
    const shim = await untilListening(() => handle)

    // Exercising the CLI's raw HTTP surface end to end; the assertion is on
    // the bare Response body.
    // oxlint-disable-next-line socket/no-fetch-prefer-http-request -- raw HTTP
    const response = await fetch(`${shim.url}/v1/messages`, {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: 'read the readme', role: 'user' }],
        model: 'local',
        tools: [
          {
            description: 'Read a file.',
            input_schema: {
              properties: { path: { type: 'string' } },
              type: 'object',
            },
            name: 'read_file',
          },
        ],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(200)
    const message = (await response.json()) as {
      content: Array<{ input: object; name: string; type: string }>
      stop_reason: string
    }
    expect(message.stop_reason).toBe('tool_use')
    expect(message.content[0]?.type).toBe('tool_use')
    expect(message.content[0]?.name).toBe('read_file')
    expect(message.content[0]?.input).toEqual({ path: 'README.md' })
    expect(stderr.text()).toContain('ANTHROPIC_BASE_URL=')

    stop.resolve()
    expect(await codePromise).toBe(0)
  })

  it('reports a task failure when the port is already taken', async () => {
    const blocker = createServer()
    await new Promise<void>(resolve => {
      blocker.listen(0, '127.0.0.1', resolve)
    })
    const address = blocker.address()
    const port =
      address !== null && typeof address === 'object' ? address.port : 0
    try {
      const stderr = createCapture()
      const code = await runCli(['serve', '--port', String(port)], {
        backend: createSimulatorBackend({ fallback: '', rules: [] }),
        env: {},
        stderr: stderr.write,
        // The bind failure returns before the stop signal matters.
        stopServing: new Promise<void>(() => {}),
      })
      expect(code).toBe(1)
      expect(stderr.text()).toContain('odai serve:')
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close(error =>
          error === undefined ? resolve() : reject(error),
        )
      })
    }
  })
})
