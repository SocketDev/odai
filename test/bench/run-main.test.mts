import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { main } from '../../src/bench/run.mts'
import type { BackendName, OdaiBackend } from '../../src/backends/types.mts'
import type { OdaiModel } from '../../src/model.mts'

const boundary = vi.hoisted(() => ({
  chrome: vi.fn(),
  createBackend: vi.fn(),
  createModel: vi.fn(),
  log: vi.fn(),
  route: vi.fn(),
  run: vi.fn(),
  simulator: vi.fn(),
}))

vi.mock(import('../../src/backends/chrome-builtin.mts'), async original => ({
  ...(await original()),
  createChromeBuiltinBackend: boundary.chrome,
}))
vi.mock(import('../../src/backends/simulator.mts'), async original => ({
  ...(await original()),
  createSimulatorBackend: boundary.simulator,
}))
vi.mock(import('../../src/backends/registry.mts'), async original => ({
  ...(await original()),
  createBackend: boundary.createBackend,
}))
vi.mock(import('../../src/model.mts'), async original => ({
  ...(await original()),
  createOdaiModel: boundary.createModel,
}))
vi.mock(import('../../src/routing.mts'), async original => ({
  ...(await original()),
  preferredTaskBackend: boundary.route,
}))
vi.mock(import('../../src/bench/index.mts'), async original => ({
  ...(await original()),
  allScenarios: [
    { name: 'example-first', task: 'patch' as const, run: boundary.run },
    { name: 'example-second', run: boundary.run },
  ],
}))
vi.mock(import('@socketsecurity/lib-stable/logger/default'), () => ({
  getDefaultLogger: () => ({ log: boundary.log }),
}))

const models: Array<{ model: OdaiModel; destroy: ReturnType<typeof vi.fn> }> =
  []
const backends: Array<OdaiBackend & { close: ReturnType<typeof vi.fn> }> = []
const initialExitCode = process.exitCode

function createOwnedBackend(name: BackendName) {
  const backend = {
    name,
    availability: vi.fn(),
    languageModel: vi.fn(),
    close: vi.fn(async () => {}),
  }
  backends.push(backend)
  return backend
}

function createOwnedModel(): OdaiModel {
  const destroy = vi.fn()
  const model: OdaiModel = {
    promptStructured: vi.fn(),
    promptStreaming: vi.fn(),
    rawSession: () => ({
      destroy,
      prompt: async () => 'Gemini Nano',
      promptStreaming: async function* () {
        yield 'fixture'
      },
    }),
  }
  models.push({ model, destroy })
  return model
}

beforeEach(() => {
  vi.clearAllMocks()
  models.length = 0
  backends.length = 0
  boundary.createModel.mockImplementation(async () => createOwnedModel())
  boundary.chrome.mockImplementation(() => createOwnedBackend('chrome-builtin'))
  boundary.simulator.mockImplementation(() => createOwnedBackend('simulator'))
  boundary.createBackend.mockImplementation(createOwnedBackend)
  boundary.route.mockReturnValue(undefined)
  boundary.run.mockResolvedValue({
    assertion: 'fixture passed',
    ok: true,
    raw: '',
    score: 1,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.exitCode = initialExitCode
})

it('describes usage from process arguments without opening a backend', async () => {
  vi.stubGlobal('process', { ...process, argv: ['node', 'bench', '--help'] })
  await main()
  expect(boundary.log).toHaveBeenCalledOnce()
  expect(boundary.createModel).not.toHaveBeenCalled()
})

it('rejects unmatched scenario selection before setup', async () => {
  await expect(main(['--scenario=missing'])).rejects.toThrow()
  expect(boundary.createModel).not.toHaveBeenCalled()
})

it.each([
  { argv: [] },
  { argv: ['--backend=simulator'] },
  { argv: ['--backend=chrome-builtin'] },
  { argv: ['--backend=llama-server'] },
])(
  'runs selected scenarios and closes every owned resource: %j',
  async ({ argv }) => {
    await main([...argv, '--scenario=example', '--json'])
    const report = JSON.parse(boundary.log.mock.calls[0]![0] as string)
    expect(report).toMatchObject({ passed: 2, total: 2 })
    expect(boundary.run).toHaveBeenCalledTimes(2)
    expect(models[0]!.destroy).toHaveBeenCalledOnce()
    expect(backends[0]!.close).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(0)
  },
)

it('runs mock evaluation without allocating a backend and reports failed scenarios', async () => {
  boundary.run.mockResolvedValue({
    assertion: 'fixture failed',
    ok: false,
    raw: '',
    score: 0,
  })
  await main(['--mock'])
  expect(boundary.log.mock.calls[0]![0]).toContain('0/2 passed')
  expect(boundary.createModel).not.toHaveBeenCalled()
  expect(process.exitCode).toBe(1)
})

it('reuses an acquired routed backend and resolves unnamed task routes', async () => {
  boundary.route.mockReturnValue('llama-server')
  await main(['--routed'])
  expect(boundary.createBackend).toHaveBeenCalledExactlyOnceWith('llama-server')
  expect(boundary.route.mock.calls).toEqual([
    [['patch']],
    [['patch']],
    [['example-second']],
  ])
  expect(models[0]!.destroy).toHaveBeenCalledOnce()
})

it('uses the default routed backend when no task preference exists', async () => {
  await main(['--routed', '--scenario=example-second'])
  expect(boundary.chrome).toHaveBeenCalledOnce()
  expect(boundary.route.mock.calls).toEqual([
    [['example-second']],
    [['example-second']],
  ])
  expect(backends[0]!.close).toHaveBeenCalledOnce()
})

it('closes the backend after model setup fails', async () => {
  const failure = new Error('fixture setup failed')
  boundary.createModel.mockRejectedValueOnce(failure)
  await expect(main([])).rejects.toBe(failure)
  expect(backends[0]!.close).toHaveBeenCalledOnce()
  expect(boundary.run).not.toHaveBeenCalled()
})

it('destroys the model and closes the backend after scenario failure', async () => {
  const failure = new Error('fixture evaluation failed')
  boundary.run.mockRejectedValueOnce(failure)
  await expect(main([])).rejects.toBe(failure)
  expect(models[0]!.destroy).toHaveBeenCalledOnce()
  expect(backends[0]!.close).toHaveBeenCalledOnce()
})
