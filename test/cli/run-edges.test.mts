import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

import type { BackendName, OdaiBackend } from '../../src/backends/types.mts'
import { createSimulatorBackend } from '../../src/backends/simulator.mts'
import {
  runBackendsCommand,
  runBatchCommand,
  runCli,
} from '../../src/cli/run.mts'

const logger = getDefaultLogger()

const boundary = vi.hoisted(() => ({
  createBackend: vi.fn(),
  selectBackend: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
}))

vi.mock(import('../../src/backends/registry.mts'), () => ({
  backendNames: ['simulator', 'llama-server'] as const,
  createBackend: boundary.createBackend,
  selectBackend: boundary.selectBackend,
  isBackendName: (name: string) =>
    name === 'llama-server' || name === 'simulator',
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(logger, 'log').mockImplementation(boundary.log)
  vi.spyOn(logger, 'error').mockImplementation(boundary.error)
})
afterEach(() => {
  vi.restoreAllMocks()
})

it('probes the registered backend set and closes each instance', async () => {
  const availableClose = vi.fn(async () => {})
  const unavailableClose = vi.fn(async () => {})
  const available = {
    ...createSimulatorBackend(),
    close: availableClose,
  }
  const unavailable: OdaiBackend & { close: () => Promise<void> } = {
    name: 'llama-server',
    availability: vi.fn(async () => ({
      available: false,
      reason: 'fixture offline',
    })),
    languageModel: vi.fn(),
    close: unavailableClose,
  }
  boundary.createBackend.mockImplementation((name: BackendName) =>
    name === 'simulator' ? available : unavailable,
  )
  const stdout = vi.fn()
  await expect(runBackendsCommand(undefined, stdout)).resolves.toBe(0)
  expect(boundary.createBackend.mock.calls).toEqual([
    ['simulator'],
    ['llama-server'],
  ])
  expect(availableClose).toHaveBeenCalledOnce()
  expect(unavailableClose).toHaveBeenCalledOnce()
  expect(JSON.parse(stdout.mock.calls[0]![0] as string)).toEqual({
    backends: [
      { name: 'simulator', available: true },
      { name: 'llama-server', available: false, reason: 'fixture offline' },
    ],
  })
})

it('reports batch setup failure and closes the backend without creating a session', async () => {
  const close = vi.fn(async () => {})
  const languageModel = vi.fn(async () => {
    throw new Error('fixture model initialization failed')
  })
  const backend = { ...createSimulatorBackend(), close, languageModel }
  boundary.selectBackend.mockResolvedValue(backend)
  const stdout = vi.fn()
  const stderr = vi.fn()
  await expect(
    runBatchCommand(backend, [], 1000, stdout, stderr),
  ).resolves.toBe(1)
  expect(languageModel).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
  expect(stdout).not.toHaveBeenCalled()
  expect(stderr).toHaveBeenCalledOnce()
})

it('uses the default output writers for help and usage errors', async () => {
  await expect(runCli(['--help'], { env: {} })).resolves.toBe(0)
  expect(boundary.log).toHaveBeenCalledOnce()
  expect(boundary.error).not.toHaveBeenCalled()
  await expect(runCli([], { env: {} })).resolves.toBe(2)
  expect(boundary.error).toHaveBeenCalledTimes(2)
  expect(boundary.createBackend).not.toHaveBeenCalled()
})

it('propagates input I/O failure before backend selection', async () => {
  const failure = new Error('fixture pipe read failed')
  const stdout = vi.fn()
  const stderr = vi.fn()
  await expect(
    runCli(['triage'], {
      env: {},
      readStdin: async () => {
        throw failure
      },
      stdout,
      stderr,
    }),
  ).rejects.toBe(failure)
  expect(boundary.selectBackend).not.toHaveBeenCalled()
  expect(stdout).not.toHaveBeenCalled()
  expect(stderr).not.toHaveBeenCalled()
})
