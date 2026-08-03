import { describe, expect, it } from 'vitest'

import { createSimulatorBackend } from '../../src/backends/simulator.mts'
import {
  BATCH_MANIFEST_SHAPE,
  BATCH_TASK_COMMANDS,
  parseBatchManifest,
  runBatchEntries,
} from '../../src/cli/batch.mts'
import { CliUsageError, parseCliArgs } from '../../src/cli/args.mts'
import { runCli } from '../../src/cli/run.mts'
import { createMockModel } from '../../src/node.mts'
import type { OdaiBackend } from '../../src/backends/types.mts'
import type { OdaiModel } from '../../src/model.mts'
import type { StructuredPromptOptions, TaskResult } from '../../src/types.mts'

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

describe('parseBatchManifest', () => {
  it('returns entries in manifest order and JSON.stringifies an object input', () => {
    const text = [
      '{"id":"a","task":"summarize","input":"hello"}',
      '{"id":"b","task":"commit-msg","input":{"diff":"---"}}',
    ].join('\n')
    const entries = parseBatchManifest(text)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ id: 'a', input: 'hello', task: 'summarize' })
    expect(entries[1]).toEqual({
      id: 'b',
      input: '{"diff":"---"}',
      task: 'commit-msg',
    })
  })

  it('skips blank lines while reporting physical line numbers in errors', () => {
    const text = ['', '', 'not-json'].join('\n')
    expect(() => parseBatchManifest(text)).toThrow(/line 3/)
  })

  it('reports the shape example on invalid JSON', () => {
    expect(() => parseBatchManifest('bad json')).toThrow(
      /is not valid JSON — each manifest line is/,
    )
    expect(() => parseBatchManifest('bad json')).toThrow(BATCH_MANIFEST_SHAPE)
  })

  it('rejects a non-object line (null, array, primitive)', () => {
    expect(() => parseBatchManifest('null')).toThrow(/must be a JSON object/)
    expect(() => parseBatchManifest('[1,2]')).toThrow(/must be a JSON object/)
    expect(() => parseBatchManifest('"string"')).toThrow(
      /must be a JSON object/,
    )
  })

  it('rejects a missing or empty id', () => {
    expect(() =>
      parseBatchManifest('{"task":"summarize","input":"x"}'),
    ).toThrow(/needs a non-empty string "id"/)
    expect(() =>
      parseBatchManifest('{"id":"","task":"summarize","input":"x"}'),
    ).toThrow(/needs a non-empty string "id"/)
  })

  it('rejects a duplicate id and names the id', () => {
    const text = [
      '{"id":"dup","task":"summarize","input":"x"}',
      '{"id":"dup","task":"commit-msg","input":"y"}',
    ].join('\n')
    expect(() => parseBatchManifest(text)).toThrow(/reuses id "dup"/)
  })

  it('rejects an unknown task with the expected list', () => {
    expect(() =>
      parseBatchManifest('{"id":"x","task":"unknown-cmd","input":"y"}'),
    ).toThrow(/is not a batch task; expected/)
    expect(() =>
      parseBatchManifest('{"id":"x","task":"unknown-cmd","input":"y"}'),
    ).toThrow(BATCH_TASK_COMMANDS[0])
  })

  it('rejects "backends" and "batch" as tasks', () => {
    expect(() =>
      parseBatchManifest('{"id":"x","task":"backends","input":"y"}'),
    ).toThrow(/is not a batch task/)
    expect(() =>
      parseBatchManifest('{"id":"x","task":"batch","input":"y"}'),
    ).toThrow(/is not a batch task/)
  })

  it('rejects patch without instruction', () => {
    expect(() =>
      parseBatchManifest('{"id":"x","task":"patch","input":"y"}'),
    ).toThrow(/patch needs an "instruction" string/)
  })

  it('rejects instruction on a non-patch task', () => {
    expect(() =>
      parseBatchManifest(
        '{"id":"x","task":"summarize","input":"y","instruction":"z"}',
      ),
    ).toThrow(/"instruction" only applies to patch/)
  })

  it('rejects a numeric input', () => {
    expect(() =>
      parseBatchManifest('{"id":"x","task":"summarize","input":42}'),
    ).toThrow(/"input" must be a string or a JSON object/)
  })

  it('rejects a blank-string input', () => {
    expect(() =>
      parseBatchManifest('{"id":"x","task":"summarize","input":""}'),
    ).toThrow(/"input" is empty/)
  })

  it('rejects an empty manifest', () => {
    expect(() => parseBatchManifest('')).toThrow(
      /the manifest is empty — pass at least one/,
    )
    expect(() => parseBatchManifest('   \n  \n')).toThrow(
      /the manifest is empty/,
    )
  })

  it('ignores extra unknown keys', () => {
    const entries = parseBatchManifest(
      '{"id":"a","task":"summarize","input":"hello","extra":"ignored"}',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ id: 'a', input: 'hello', task: 'summarize' })
  })
})

describe('parseCliArgs — batch command', () => {
  it('parses batch as a command', () => {
    const args = parseCliArgs(['batch'])
    expect(args.command).toBe('batch')
  })

  it('throws on batch --raw', () => {
    expect(() => parseCliArgs(['batch', '--raw'])).toThrow(CliUsageError)
    expect(() => parseCliArgs(['batch', '--raw'])).toThrow(
      /does not apply to the batch command/,
    )
  })

  it('throws on batch --instruction', () => {
    expect(() => parseCliArgs(['batch', '--instruction', 'x'])).toThrow(
      /only applies to the patch command/,
    )
  })
})

describe('runBatchEntries', () => {
  it('writes two JSONL lines in manifest order with ok:true for summarize', async () => {
    const model = createMockModel('{"summary":"s","keyPoints":["k"]}')
    const entries = parseBatchManifest(
      [
        '{"id":"first","task":"summarize","input":"hello"}',
        '{"id":"second","task":"summarize","input":"world"}',
      ].join('\n'),
    )
    const out = createCapture()
    await runBatchEntries(model, entries, 5000, out.write)
    expect(out.lines).toHaveLength(2)
    const first = JSON.parse(out.lines[0]!) as { id: string; ok: boolean }
    const second = JSON.parse(out.lines[1]!) as { id: string; ok: boolean }
    expect(first.id).toBe('first')
    expect(first.ok).toBe(true)
    expect(second.id).toBe('second')
    expect(second.ok).toBe(true)
  })

  it('records a failing entry in-band and still runs the next entry', async () => {
    let call = 0
    const model: OdaiModel = {
      async promptStructured<T>(
        _content: string,
        _options: StructuredPromptOptions<T>,
      ): Promise<TaskResult<T>> {
        call += 1
        if (call === 1) {
          return { ok: false, raw: 'bad', error: 'validation failed' }
        }
        return {
          ok: true,
          data: { summary: 's', keyPoints: ['k'] } as T,
          raw: '{"summary":"s","keyPoints":["k"]}',
        }
      },
      async promptStreaming(): Promise<{ raw: string }> {
        return { raw: '' }
      },
      rawSession() {
        return {
          prompt: async () => '',
          promptStreaming: () =>
            (async function* gen(): AsyncGenerator<string> {})(),
        }
      },
    }
    const entries = parseBatchManifest(
      [
        '{"id":"a","task":"summarize","input":"x"}',
        '{"id":"b","task":"summarize","input":"y"}',
      ].join('\n'),
    )
    const out = createCapture()
    await runBatchEntries(model, entries, 5000, out.write)
    expect(out.lines).toHaveLength(2)
    const first = JSON.parse(out.lines[0]!) as {
      id: string
      ok: boolean
      error?: string | undefined
    }
    const second = JSON.parse(out.lines[1]!) as { id: string; ok: boolean }
    expect(first.id).toBe('a')
    expect(first.ok).toBe(false)
    expect(first.error).toContain('validation failed')
    expect(second.id).toBe('b')
    expect(second.ok).toBe(true)
  })

  it('reports a timeout as ok:false and still runs the next entry', async () => {
    let call = 0
    const model: OdaiModel = {
      async promptStructured<T>(
        _content: string,
        _options: StructuredPromptOptions<T>,
      ): Promise<TaskResult<T>> {
        call += 1
        if (call === 1) {
          return new Promise<TaskResult<T>>(() => {})
        }
        return {
          ok: true,
          data: { summary: 's', keyPoints: ['k'] } as T,
          raw: '{"summary":"s","keyPoints":["k"]}',
        }
      },
      async promptStreaming(): Promise<{ raw: string }> {
        return { raw: '' }
      },
      rawSession() {
        return {
          prompt: async () => '',
          promptStreaming: () =>
            (async function* gen(): AsyncGenerator<string> {})(),
        }
      },
    }
    const entries = parseBatchManifest(
      [
        '{"id":"slow","task":"summarize","input":"x"}',
        '{"id":"fast","task":"summarize","input":"y"}',
      ].join('\n'),
    )
    const out = createCapture()
    await runBatchEntries(model, entries, 20, out.write)
    expect(out.lines).toHaveLength(2)
    const first = JSON.parse(out.lines[0]!) as {
      id: string
      ok: boolean
      error?: string | undefined
    }
    expect(first.id).toBe('slow')
    expect(first.ok).toBe(false)
    expect(first.error).toMatch(/did not finish within 20ms/)
    const second = JSON.parse(out.lines[1]!) as { id: string; ok: boolean }
    expect(second.id).toBe('fast')
    expect(second.ok).toBe(true)
  })
})

describe('runCli — batch end-to-end', () => {
  it('exits 0, prints two stdout lines in order, and creates the backend once', async () => {
    let createCount = 0
    const countingBackend: OdaiBackend = {
      async availability() {
        return { available: true }
      },
      async languageModel() {
        return {
          availability: async () => 'available',
          create: async () => {
            createCount += 1
            return {
              prompt: async () => '{"summary":"s","keyPoints":["k"]}',
              promptStreaming: () =>
                (async function* gen(): AsyncGenerator<string> {})(),
            }
          },
        }
      },
      name: 'simulator',
    }
    const manifest = [
      '{"id":"a","task":"summarize","input":"hello"}',
      '{"id":"b","task":"summarize","input":"world"}',
    ].join('\n')
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await runCli(['batch'], {
      backend: countingBackend,
      env: {},
      readStdin: async () => manifest,
      stderr: stderr.write,
      stdout: stdout.write,
    })
    expect(code).toBe(0)
    expect(stdout.lines).toHaveLength(2)
    const first = JSON.parse(stdout.lines[0]!) as { id: string; ok: boolean }
    const second = JSON.parse(stdout.lines[1]!) as { id: string; ok: boolean }
    expect(first.id).toBe('a')
    expect(second.id).toBe('b')
    expect(createCount).toBe(1)
  })

  it('exits 0 with every line ok:false when the simulator reply is not valid JSON', async () => {
    const manifest = [
      '{"id":"a","task":"summarize","input":"hello"}',
      '{"id":"b","task":"summarize","input":"world"}',
    ].join('\n')
    const stdout = createCapture()
    const code = await runCli(['batch'], {
      backend: createSimulatorBackend({ fallback: 'not json at all' }),
      env: {},
      readStdin: async () => manifest,
      stderr: createCapture().write,
      stdout: stdout.write,
    })
    expect(code).toBe(0)
    expect(stdout.lines).toHaveLength(2)
    for (const line of stdout.lines) {
      const parsed = JSON.parse(line) as { ok: boolean }
      expect(parsed.ok).toBe(false)
    }
  })

  it('exits 2 on a malformed manifest, names the line on stderr, and never probes the backend', async () => {
    let createCount = 0
    const countingBackend: OdaiBackend = {
      async availability() {
        return { available: true }
      },
      async languageModel() {
        return {
          availability: async () => 'available',
          create: async () => {
            createCount += 1
            return {
              prompt: async () => '',
              promptStreaming: () =>
                (async function* gen(): AsyncGenerator<string> {})(),
            }
          },
        }
      },
      name: 'simulator',
    }
    const stdout = createCapture()
    const stderr = createCapture()
    const code = await runCli(['batch'], {
      backend: countingBackend,
      env: {},
      readStdin: async () => 'not valid json',
      stderr: stderr.write,
      stdout: stdout.write,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toContain('line 1')
    expect(stdout.lines).toHaveLength(0)
    expect(createCount).toBe(0)
  })

  it('exits 69 and prints provisioning help when no backend is available', async () => {
    const manifest = '{"id":"a","task":"summarize","input":"hello"}'
    const stderr = createCapture()
    const code = await runCli(['batch'], {
      backend: {
        async availability() {
          return { available: false, reason: 'engine offline' }
        },
        async languageModel(): Promise<never> {
          throw new Error('unavailable')
        },
        name: 'llama-server',
      },
      env: {},
      readStdin: async () => manifest,
      stderr: stderr.write,
      stdout: createCapture().write,
    })
    expect(code).toBe(69)
    expect(stderr.text()).toContain('Provisioning:')
  })

  it('exits 2 when --raw is passed with batch', async () => {
    const stderr = createCapture()
    const code = await runCli(['batch', '--raw'], {
      env: {},
      readStdin: async () => '{"id":"a","task":"summarize","input":"x"}',
      stderr: stderr.write,
      stdout: createCapture().write,
    })
    expect(code).toBe(2)
    expect(stderr.text()).toContain('does not apply to the batch command')
  })
})
