import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'

import { LOCAI_APPLE_FM_SHIM_ENV_VAR } from '../../src/backends/apple-fm.mts'
import {
  backendNames,
  createBackend,
  defaultProbeOrder,
  selectBackend,
} from '../../src/backends/registry.mts'
import { LOCAI_LLAMA_URL_ENV_VAR } from '../../src/backends/llama-server.mts'
import { LanguageModelSimulator } from '../../src/simulator.mts'
import type { LocaiBackend } from '../../src/backends/types.mts'

/**
 * Mock apple-fm shim reporting deviceNotEligible, so registry results don't
 * depend on this machine's macOS version or Apple Intelligence state.
 */
const APPLE_FM_MOCK_SHIM_SOURCE = `import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', () => {
  process.stdout.write(JSON.stringify({ ok: true, availability: 'unavailable', reason: 'deviceNotEligible' }) + '\\n')
})
`

/**
 * Reserve an ephemeral port and release it, so the llama-server probe hits a
 * port that is closed no matter what runs on this machine.
 */
async function reserveClosedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

describe('backend registry', () => {
  let originalAppleFmShim: string | undefined
  let originalLanguageModel: unknown
  let originalLlamaUrl: string | undefined

  beforeAll(async () => {
    originalLlamaUrl = process.env[LOCAI_LLAMA_URL_ENV_VAR]
    const closedPort = await reserveClosedPort()
    process.env[LOCAI_LLAMA_URL_ENV_VAR] = `http://127.0.0.1:${closedPort}`
    originalAppleFmShim = process.env[LOCAI_APPLE_FM_SHIM_ENV_VAR]
    const mockDir = await mkdtemp(path.join(os.tmpdir(), 'locai-registry-'))
    const mockShimPath = path.join(mockDir, 'apple-fm-mock-shim.mjs')
    await writeFile(mockShimPath, APPLE_FM_MOCK_SHIM_SOURCE)
    process.env[LOCAI_APPLE_FM_SHIM_ENV_VAR] = mockShimPath
  })

  afterAll(() => {
    if (originalLlamaUrl === undefined) {
      delete process.env[LOCAI_LLAMA_URL_ENV_VAR]
    } else {
      process.env[LOCAI_LLAMA_URL_ENV_VAR] = originalLlamaUrl
    }
    if (originalAppleFmShim === undefined) {
      delete process.env[LOCAI_APPLE_FM_SHIM_ENV_VAR]
    } else {
      process.env[LOCAI_APPLE_FM_SHIM_ENV_VAR] = originalAppleFmShim
    }
  })

  beforeEach(() => {
    originalLanguageModel = (
      globalThis as { LanguageModel?: unknown | undefined }
    ).LanguageModel
    ;(globalThis as { LanguageModel?: unknown | undefined }).LanguageModel =
      undefined
  })

  afterEach(() => {
    ;(globalThis as { LanguageModel?: unknown | undefined }).LanguageModel =
      originalLanguageModel
  })

  it('declares all four backends and probes real engines before the simulator', () => {
    expect([...backendNames].toSorted()).toEqual([
      'apple-fm',
      'gemini-nano-headless',
      'llama-server',
      'simulator',
    ])
    expect(defaultProbeOrder[0]).toBe('gemini-nano-headless')
    expect(defaultProbeOrder[defaultProbeOrder.length - 1]).toBe('simulator')
  })

  it('reports availability per backend with a reason when unavailable', async () => {
    expect(await createBackend('simulator').availability()).toEqual({
      available: true,
    })
    const nano = await createBackend('gemini-nano-headless').availability()
    expect(nano.available).toBe(false)
    expect(nano.reason).toContain('LanguageModel global')
    const llama = await createBackend('llama-server').availability()
    expect(llama.available).toBe(false)
    expect(llama.reason).toContain('not reachable')
    const apple = await createBackend('apple-fm').availability()
    expect(apple.available).toBe(false)
    expect(apple.reason).toContain('deviceNotEligible')
  })

  it('prefers the explicit backend option over env and probe', async () => {
    const backend = await selectBackend({
      backend: 'simulator',
      env: { LOCAI_BACKEND: 'gemini-nano-headless' },
    })
    expect(backend.name).toBe('simulator')
  })

  it('accepts a caller-built backend instance when it is available', async () => {
    const custom: LocaiBackend = {
      async availability() {
        return { available: true }
      },
      async languageModel() {
        return new LanguageModelSimulator()
      },
      name: 'simulator',
    }
    const backend = await selectBackend({ backend: custom })
    expect(backend).toBe(custom)
  })

  it('throws with the reason when the explicit backend is unavailable', async () => {
    await expect(selectBackend({ backend: 'apple-fm' })).rejects.toThrow(
      /apple-fm.*deviceNotEligible/s,
    )
  })

  it('prefers LOCAI_BACKEND env over the probe order', async () => {
    ;(globalThis as { LanguageModel?: object | undefined }).LanguageModel =
      new LanguageModelSimulator()
    const backend = await selectBackend({ env: { LOCAI_BACKEND: 'simulator' } })
    expect(backend.name).toBe('simulator')
  })

  it('throws with the reason when LOCAI_BACKEND names an unavailable backend', async () => {
    await expect(
      selectBackend({ env: { LOCAI_BACKEND: 'llama-server' } }),
    ).rejects.toThrow(/llama-server.*not reachable/s)
  })

  it('rejects an unknown LOCAI_BACKEND value listing valid names', async () => {
    await expect(
      selectBackend({ env: { LOCAI_BACKEND: 'gpt-42' } }),
    ).rejects.toThrow(/gpt-42.*simulator/s)
  })

  it('auto-selects gemini-nano-headless when a LanguageModel global is available', async () => {
    ;(globalThis as { LanguageModel?: object | undefined }).LanguageModel =
      new LanguageModelSimulator()
    const backend = await selectBackend({ env: {} })
    expect(backend.name).toBe('gemini-nano-headless')
  })

  it('falls through unavailable backends to the simulator in a bare runtime', async () => {
    const backend = await selectBackend({ env: {} })
    expect(backend.name).toBe('simulator')
  })

  it('aggregates every probed reason when no backend is available', async () => {
    await expect(
      selectBackend({
        env: {},
        probe: ['gemini-nano-headless', 'llama-server', 'apple-fm'],
      }),
    ).rejects.toThrow(/gemini-nano-headless.*llama-server.*apple-fm/s)
  })
})
