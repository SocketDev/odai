import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createSimulatorBackend } from '../../src/backends/simulator.mts'
import {
  closeBackend,
  runCli,
  runTask,
  truncateForLog,
  withTimeout,
} from '../../src/cli/run.mts'
import { createMockModel } from '../../src/node.mts'
import type { OdaiBackend } from '../../src/backends/types.mts'
import type { SessionLike } from '../../src/types.mts'

interface Capture {
  lines: string[]
  text: () => string
  write: (line: string) => void
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

function createHangingBackend(): OdaiBackend {
  const session: SessionLike = {
    prompt: () => new Promise<string>(() => {}),
    promptStreaming: () =>
      (async function* generate(): AsyncGenerator<string> {})(),
  }
  return {
    async availability() {
      return { available: true }
    },
    async languageModel() {
      return {
        availability: async () => 'available',
        create: async () => session,
      }
    },
    name: 'simulator',
  }
}

function createTriageBackend(): OdaiBackend {
  return createSimulatorBackend({
    fallback: 'no rule matched',
    rules: [
      {
        response:
          '{"sentences":["There are 2 critical and 5 high findings."],"topConcern":"critical"}',
        when: text => text.includes('Critical: 2'),
      },
    ],
  })
}

describe('runCli', () => {
  it('runs triage through an available backend and prints parsed JSON', async () => {
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await runCli(['triage'], {
      backend: createTriageBackend(),
      env: {},
      readStdin: async () => 'Critical: 2\nHigh: 5\nMedium: 1\nLow: 4',
      stderr: stderr.write,
      stdout: stdout.write,
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.lines[0]!) as {
      sentences: string[]
      topConcern: string
    }
    expect(parsed.topConcern).toBe('critical')
    expect(parsed.sentences[0]).toContain('critical')
  })

  it('prints the raw reply with --raw', async () => {
    const stdout = createCapture()
    const code = await runCli(['triage', '--raw'], {
      backend: createTriageBackend(),
      env: {},
      readStdin: async () => 'Critical: 2',
      stderr: createCapture().write,
      stdout: stdout.write,
    })
    expect(code).toBe(0)
    expect(stdout.lines[0]).toContain('"topConcern":"critical"')
  })

  it('runs commit-msg through a canned backend', async () => {
    const stdout = createCapture()
    const code = await runCli(['commit-msg'], {
      backend: createSimulatorBackend({
        fallback: '{"subject":"chore: fallback"}',
        rules: [
          {
            response: '{"subject":"fix(parse): handle empty input"}',
            when: text => text.includes('diff --git'),
          },
        ],
      }),
      env: {},
      readStdin: async () => 'diff --git a/parse.js b/parse.js',
      stderr: createCapture().write,
      stdout: stdout.write,
    })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.lines[0]!)).toEqual({
      subject: 'fix(parse): handle empty input',
    })
  })

  it('exits 69 with provisioning help when no backend is available', async () => {
    const stderr = createCapture()
    const code = await runCli(['triage'], {
      backend: createUnavailableBackend('engine offline'),
      env: {},
      readStdin: async () => 'Critical: 2',
      stderr: stderr.write,
      stdout: createCapture().write,
    })
    expect(code).toBe(69)
    expect(stderr.text()).toContain('engine offline')
    expect(stderr.text()).toContain('Provisioning:')
    expect(stderr.text()).toContain('ODAI_NANO_ALLOW_DOWNLOAD=1')
    expect(stderr.text()).toContain('clean-skip signal')
  })

  it('exits 1 with a loud budget message when the prompt times out', async () => {
    const stderr = createCapture()
    const code = await runCli(['triage', '--timeout', '50'], {
      backend: createHangingBackend(),
      env: {},
      readStdin: async () => 'Critical: 2',
      stderr: stderr.write,
      stdout: createCapture().write,
    })
    expect(code).toBe(1)
    expect(stderr.text()).toContain('did not finish within 50ms')
    expect(stderr.text()).toContain('ODAI_TIMEOUT_MS')
  })

  it('reads the timeout from ODAI_TIMEOUT_MS', async () => {
    const stderr = createCapture()
    const code = await runCli(['triage'], {
      backend: createHangingBackend(),
      env: { ODAI_TIMEOUT_MS: '60' },
      readStdin: async () => 'Critical: 2',
      stderr: stderr.write,
      stdout: createCapture().write,
    })
    expect(code).toBe(1)
    expect(stderr.text()).toContain('did not finish within 60ms')
  })

  it('rejects an invalid ODAI_TIMEOUT_MS as a usage error', async () => {
    const stderr = createCapture()
    const code = await runCli(['triage'], {
      backend: createTriageBackend(),
      env: { ODAI_TIMEOUT_MS: 'soon' },
      readStdin: async () => 'Critical: 2',
      stderr: stderr.write,
      stdout: createCapture().write,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toContain('ODAI_TIMEOUT_MS')
  })

  it('exits 1 when the reply fails validation', async () => {
    const stderr = createCapture()
    const code = await runCli(['triage'], {
      backend: createSimulatorBackend({ fallback: '{"sentences":"prose"}' }),
      env: {},
      readStdin: async () => 'Critical: 2',
      stderr: stderr.write,
      stdout: createCapture().write,
    })
    expect(code).toBe(1)
    expect(stderr.text()).toContain('failed validation')
    expect(stderr.text()).toContain('raw reply:')
  })

  it('exits 2 on usage errors and prints usage', async () => {
    const stderr = createCapture()
    const code = await runCli(['deploy'], {
      env: {},
      stderr: stderr.write,
      stdout: createCapture().write,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toContain('unknown command')
    expect(stderr.text()).toContain('Usage: odai')
  })

  it('exits 2 when no command is given', async () => {
    const stderr = createCapture()
    const code = await runCli([], {
      env: {},
      stderr: stderr.write,
      stdout: createCapture().write,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toContain('no command given')
  })

  it('exits 2 when the input is empty', async () => {
    const stderr = createCapture()
    const code = await runCli(['triage'], {
      backend: createTriageBackend(),
      env: {},
      readStdin: async () => '   ',
      stderr: stderr.write,
      stdout: createCapture().write,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toContain('input is empty')
  })

  it('exits 2 when --input names a missing file', async () => {
    const stderr = createCapture()
    const code = await runCli(['triage', '--input', 'no/such/file.txt'], {
      backend: createTriageBackend(),
      env: {},
      stderr: stderr.write,
      stdout: createCapture().write,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toContain('cannot read --input')
  })

  it('prints usage on --help and exits 0', async () => {
    const stdout = createCapture()
    const code = await runCli(['--help'], {
      env: {},
      stderr: createCapture().write,
      stdout: stdout.write,
    })
    expect(code).toBe(0)
    expect(stdout.text()).toContain('Usage: odai')
  })

  it('lists availability per backend for the backends command', async () => {
    const stdout = createCapture()
    const code = await runCli(['backends'], {
      env: {},
      probeBackends: [
        createTriageBackend(),
        createUnavailableBackend('engine offline'),
      ],
      stderr: createCapture().write,
      stdout: stdout.write,
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.text()) as {
      backends: Array<{
        available: boolean
        name: string
        reason?: string | undefined
      }>
    }
    expect(parsed.backends).toHaveLength(2)
    expect(parsed.backends[0]).toEqual({ available: true, name: 'simulator' })
    expect(parsed.backends[1]).toEqual({
      available: false,
      name: 'llama-server',
      reason: 'engine offline',
    })
  })

  it('exits 69 from the backends command when nothing is available', async () => {
    const stdout = createCapture()
    const code = await runCli(['backends'], {
      env: {},
      probeBackends: [createUnavailableBackend('engine offline')],
      stderr: createCapture().write,
      stdout: stdout.write,
    })
    expect(code).toBe(69)
  })

  it('honors ODAI_BACKEND from the injected env', async () => {
    const stdout = createCapture()
    const code = await runCli(['triage'], {
      env: { ODAI_BACKEND: 'simulator' },
      readStdin: async () => 'Critical: 2',
      stderr: createCapture().write,
      stdout: stdout.write,
    })
    expect(code).toBe(1)
  })
})

describe('runCli input and diagnostics', () => {
  it('reads input from a --input file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'odai-cli-input-'))
    const file = path.join(dir, 'alerts.txt')
    await writeFile(file, 'Critical: 2\nHigh: 5')
    const stdout = createCapture()
    const code = await runCli(['triage', '--input', file], {
      backend: createTriageBackend(),
      env: {},
      stderr: createCapture().write,
      stdout: stdout.write,
    })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.lines[0]!)).toHaveProperty('topConcern')
  })

  it('reports availability probe failures per backend', async () => {
    const throwing: OdaiBackend = {
      async availability(): Promise<never> {
        throw new Error('probe exploded')
      },
      async languageModel() {
        throw new Error('n/a')
      },
      name: 'llama-server',
    }
    const stdout = createCapture()
    const code = await runCli(['backends'], {
      env: {},
      probeBackends: [throwing],
      stderr: createCapture().write,
      stdout: stdout.write,
    })
    expect(code).toBe(69)
    const parsed = JSON.parse(stdout.text()) as {
      backends: Array<{ available: boolean; reason?: string | undefined }>
    }
    expect(parsed.backends[0]?.reason).toContain('probe exploded')
  })

  it('falls back to the default logger sinks and reports no command', async () => {
    const code = await runCli([])
    expect(code).toBe(2)
  })

  it('rejects a TTY with no input source as a usage error', async () => {
    const wasTty = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    })
    try {
      const stderr = createCapture()
      const code = await runCli(['triage'], {
        backend: createTriageBackend(),
        env: {},
        stderr: stderr.write,
        stdout: createCapture().write,
      })
      expect(code).toBe(2)
      expect(stderr.text()).toContain('nothing to read')
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: wasTty,
      })
    }
  })
})

describe('runTask', () => {
  const model = createMockModel(
    '{"summary":"s","keyPoints":["a"],"subject":"chore: x",' +
      '"sentences":["one"],"topConcern":"low",' +
      '"patch":"--- a\\n+++ b","explanation":"why",' +
      '"routine":true,"reason":"pin bump","risk":"low"}',
  )

  it('routes classify-deps', async () => {
    const result = await runTask('classify-deps', model, 'diff', undefined)
    expect(result).toHaveProperty('ok')
  })

  it('routes commit-msg', async () => {
    const result = await runTask('commit-msg', model, 'diff', undefined)
    expect(result).toHaveProperty('ok')
  })

  it('routes summarize', async () => {
    const result = await runTask('summarize', model, 'text', undefined)
    expect(result).toHaveProperty('ok')
  })

  it('routes triage', async () => {
    const result = await runTask('triage', model, 'findings', undefined)
    expect(result).toHaveProperty('ok')
  })

  it('routes patch with an instruction', async () => {
    const result = await runTask('patch', model, 'file', 'use template literal')
    expect(result).toHaveProperty('ok')
  })

  it('rejects patch without an instruction', async () => {
    await expect(runTask('patch', model, 'file', undefined)).rejects.toThrow(
      /needs --instruction/,
    )
  })

  it('rejects a command that is not a prompt task', async () => {
    await expect(
      runTask('backends' as never, model, 'x', undefined),
    ).rejects.toThrow(/not a prompt command/)
  })
})

describe('closeBackend', () => {
  it('tolerates an undefined backend', async () => {
    await expect(closeBackend(undefined)).resolves.toBeUndefined()
  })

  it('swallows a rejecting close', async () => {
    const backend = {
      async close(): Promise<void> {
        throw new Error('close failed')
      },
    } as unknown as OdaiBackend
    await expect(closeBackend(backend)).resolves.toBeUndefined()
  })

  it('awaits a resolving close', async () => {
    let closed = false
    const backend = {
      async close(): Promise<void> {
        closed = true
      },
    } as unknown as OdaiBackend
    await closeBackend(backend)
    expect(closed).toBe(true)
  })
})

describe('truncateForLog', () => {
  it('returns short values unchanged', () => {
    expect(truncateForLog('short')).toBe('short')
  })

  it('truncates and appends an ellipsis past the limit', () => {
    const truncated = truncateForLog('x'.repeat(500))
    expect(truncated.endsWith('…')).toBe(true)
    expect(truncated).toHaveLength(401)
  })
})

describe('withTimeout', () => {
  it('resolves when the promise beats the budget', async () => {
    const value = await withTimeout(Promise.resolve('fast'), 1000, 'the test')
    expect(value).toBe('fast')
  })

  it('rejects with CliTimeoutError when the budget is blown', async () => {
    await expect(
      withTimeout(new Promise<string>(() => {}), 20, 'the test'),
    ).rejects.toThrow(/did not finish within 20ms/)
  })

  it('wraps a non-Error rejection as an Error', async () => {
    await expect(
      withTimeout(Promise.reject('plain string'), 1000, 'the test'),
    ).rejects.toThrow('plain string')
  })
})
