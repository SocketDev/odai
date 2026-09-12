import { afterEach, describe, expect, it, vi } from 'vitest'

import * as registry from '../../../../src/backends/registry.mts'
import { createSimulatorBackend } from '../../../../src/backends/simulator.mts'
import { parseCliArgs } from '../../../../src/cli/args.mts'
import { parseBatchManifest } from '../../../../src/cli/batch.mts'
import { runCli } from '../../../../src/cli/run.mts'
import { createLockstepExample } from '../../../../src/lockstep/examples.mts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('lockstep command integration', () => {
  it.each(['full', 'sparse'] as const)(
    'runs %s lockstep through the CLI',
    async materialization => {
      const example = createLockstepExample(materialization)
      const lines: string[] = []
      const code = await runCli(['lockstep'], {
        backend: createSimulatorBackend({
          fallback: JSON.stringify(example.output),
        }),
        env: {},
        readStdin: async () => JSON.stringify(example.input),
        stderr: () => {},
        stdout: line => lines.push(line),
      })
      expect(code).toBe(0)
      expect(JSON.parse(lines[0]!)).toEqual(example.output)
    },
  )

  it('selects the heavy backend when no override is supplied', async () => {
    const example = createLockstepExample('sparse')
    const select = vi
      .spyOn(registry, 'selectBackend')
      .mockResolvedValue(
        createSimulatorBackend({ fallback: JSON.stringify(example.output) }),
      )
    expect(
      await runCli(['lockstep'], {
        env: {},
        readStdin: async () => JSON.stringify(example.input),
        stderr: () => {},
        stdout: () => {},
      }),
    ).toBe(0)
    expect(select.mock.calls[0]?.[0]?.backend).toBe('llama-server')
  })

  it('honors explicit Gemma evaluation and environment choices', async () => {
    const example = createLockstepExample('full')
    const select = vi
      .spyOn(registry, 'selectBackend')
      .mockResolvedValue(
        createSimulatorBackend({ fallback: JSON.stringify(example.output) }),
      )
    const options = {
      readStdin: async () => JSON.stringify(example.input),
      stderr: () => {},
      stdout: () => {},
    }
    expect(
      await runCli(['lockstep', '--backend=chrome-builtin'], {
        ...options,
        env: {},
      }),
    ).toBe(0)
    expect(select.mock.calls[0]?.[0]?.backend).toBe('chrome-builtin')
    select.mockClear()
    expect(
      await runCli(['lockstep'], {
        ...options,
        env: { ODAI_BACKEND: 'simulator' },
      }),
    ).toBe(0)
    expect(select.mock.calls[0]?.[0]?.backend).toBeUndefined()
    expect(select.mock.calls[0]?.[0]?.env).toEqual({
      ODAI_BACKEND: 'simulator',
    })
  })

  it('rejects malformed evidence before starting a backend', async () => {
    const select = vi.spyOn(registry, 'selectBackend')
    expect(
      await runCli(['lockstep'], {
        env: {},
        readStdin: async () => '{"version":1}',
        stderr: () => {},
        stdout: () => {},
      }),
    ).toBe(2)
    expect(select).not.toHaveBeenCalled()
  })

  it('uses the same task and result in batch mode', async () => {
    const example = createLockstepExample('sparse')
    const lines: string[] = []
    expect(
      await runCli(['batch'], {
        backend: createSimulatorBackend({
          fallback: JSON.stringify(example.output),
        }),
        env: {},
        readStdin: async () =>
          JSON.stringify({
            id: 'parser',
            task: 'lockstep',
            input: example.input,
          }),
        stderr: () => {},
        stdout: line => lines.push(line),
      }),
    ).toBe(0)
    expect(JSON.parse(lines[0]!)).toEqual({
      id: 'parser',
      ok: true,
      value: example.output,
    })
  })

  it('rejects server lifecycle commands as batch tasks', () => {
    expect(() =>
      parseBatchManifest('{"id":"server","task":"serve","input":"unused"}'),
    ).toThrow()
    expect(parseCliArgs(['lockstep']).command).toBe('lockstep')
    expect(() => parseCliArgs(['lockstep-port'])).toThrow()
  })
})
