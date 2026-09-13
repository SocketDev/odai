import process from 'node:process'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  main,
  parseContextArgs,
} from '../../../../scripts/repo/perf/context.mts'
import { compareContextSessions } from '../../../../src/bench/context.mts'
import type { ContextReport } from '../../../../src/bench/context.mts'

const mocks = vi.hoisted(() => ({
  startBridge: vi.fn(),
  writeJson: vi.fn(),
}))

vi.mock('../../../../src/backends/chrome-builtin.mts', () => ({
  startBridge: mocks.startBridge,
}))
vi.mock('@socketsecurity/lib-stable/fs/write-json', () => ({
  stringify: (value: unknown) => JSON.stringify(value),
  writeJson: mocks.writeJson,
}))

let exitCode: typeof process.exitCode

beforeEach(() => {
  exitCode = process.exitCode
  process.exitCode = undefined
  mocks.startBridge.mockReset()
  mocks.writeJson.mockReset()
})

afterEach(() => {
  process.exitCode = exitCode
  vi.restoreAllMocks()
})

function createBridgeFixture(ok = true) {
  const report: ContextReport = {
    samples: [
      {
        contextCharacters: 80,
        contextUsage: 20,
        contextWindow: 4096,
        firstChunkMs: 2,
        inputCharacters: 10,
        mode: 'persistent',
        ok,
        output: 'READY',
        pair: 0,
        setupMs: 0,
        totalMs: 4,
        turn: 1,
      },
    ],
    userAgent: 'Fixture browser',
  }
  const bridge = {
    close: vi.fn().mockResolvedValue(undefined),
    page: { evaluate: vi.fn().mockResolvedValue(report) },
  }
  mocks.startBridge.mockResolvedValue(bridge)
  return { bridge, report }
}

it('parses defaults and explicit limits', () => {
  expect(parseContextArgs([])).toEqual({
    contextLines: 64,
    help: false,
    output: undefined,
    pairs: 3,
    timeoutMs: 120000,
  })
  expect(
    parseContextArgs([
      '--pairs',
      '20',
      '--context-lines',
      '0',
      '--timeout',
      '2147483647',
      '--output',
      'fixture report.json',
      '--json',
    ]),
  ).toEqual({
    contextLines: 0,
    help: false,
    output: 'fixture report.json',
    pairs: 20,
    timeoutMs: 2147483647,
  })
})

it.each([
  ['--pairs', '0'],
  ['--pairs', '21'],
  ['--pairs', '1.5'],
  ['--pairs', '0x10'],
  ['--pairs', '1e1'],
  ['--pairs', ''],
  ['--context-lines', '-1'],
  ['--context-lines', '257'],
  ['--timeout', '0'],
  ['--timeout', '2147483648'],
  ['--timeout', 'Infinity'],
  ['--timeout', '100ms'],
  ['--output', ''],
  ['--output', '   '],
  ['--unknown'],
  ['unexpected-position'],
  ['--pairs'],
])('rejects invalid arguments %j', (...argv) => {
  expect(() => parseContextArgs(argv)).toThrow()
})

it('shows help without creating a browser', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  await main(['--help'])
  expect(stdout).toHaveBeenCalledTimes(1)
  expect(mocks.startBridge).not.toHaveBeenCalled()
})

it('runs fixed-model evaluation and writes a structured report', async () => {
  const { bridge, report } = createBridgeFixture()
  await main([
    '--pairs',
    '1',
    '--context-lines',
    '2',
    '--timeout',
    '1000',
    '--output',
    'fixture.json',
  ])
  expect(mocks.startBridge).toHaveBeenCalledExactlyOnceWith({
    allowDownload: false,
    model: 'gemma4',
    readyTimeoutMs: 1000,
  })
  expect(bridge.page.evaluate).toHaveBeenCalledExactlyOnceWith(
    compareContextSessions,
    {
      contextLines: 2,
      pairs: 1,
      timeoutMs: 1000,
    },
  )
  expect(mocks.writeJson).toHaveBeenCalledWith(
    'fixture.json',
    expect.objectContaining({
      contextLines: 2,
      evidence: 'real',
      pairs: 1,
      requestedModel: 'gemma4',
      samples: report.samples,
      schemaVersion: 1,
      timeoutMs: 1000,
    }),
  )
  expect(bridge.close).toHaveBeenCalledTimes(1)
})

it('prints JSON and fails the exit status for an incorrect response', async () => {
  const { bridge } = createBridgeFixture(false)
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  await main(['--json'])
  const report = JSON.parse(String(stdout.mock.calls[0]![0])) as ContextReport
  expect(report.samples[0]!.ok).toBe(false)
  expect(process.exitCode).toBe(1)
  expect(bridge.close).toHaveBeenCalledTimes(1)
})

it.each(['evaluate', 'write'])(
  'closes the browser after a %s failure',
  async stage => {
    const { bridge } = createBridgeFixture()
    const failure = new Error('Fixture report failure')
    if (stage === 'evaluate') {
      bridge.page.evaluate.mockRejectedValue(failure)
    } else {
      mocks.writeJson.mockRejectedValue(failure)
    }
    await expect(main(['--output', 'fixture.json'])).rejects.toBe(failure)
    expect(bridge.close).toHaveBeenCalledTimes(1)
  },
)
