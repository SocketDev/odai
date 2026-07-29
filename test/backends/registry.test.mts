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
  vi,
} from 'vitest'

import { ODAI_APPLE_FM_SHIM_ENV_VAR } from '../../src/backends/apple-fm.mts'
import { ODAI_CHROME_ENV_VAR } from '../../src/backends/chrome-builtin.mts'
import {
  backendNames,
  createBackend,
  defaultProbeOrder,
  selectBackend,
} from '../../src/backends/registry.mts'
import { ODAI_LLAMA_URL_ENV_VAR } from '../../src/backends/llama-server.mts'
import { LanguageModelSimulator } from '../../src/simulator.mts'
import type { OdaiBackend } from '../../src/backends/types.mts'

// odai delegates built-in model resolution to socket-lib's `ai/builtin`, whose
// real resolver probes the runtime once and caches. Mock it to re-read the
// per-case `globalThis.LanguageModel` install on every call.
vi.mock(import('@socketsecurity/lib/ai/builtin'), () => ({
  getLanguageModel: () =>
    (globalThis as { LanguageModel?: unknown | undefined }).LanguageModel ??
    undefined,
}))

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
  let originalChrome: string | undefined
  let originalLanguageModel: unknown
  let originalLlamaUrl: string | undefined

  beforeAll(async () => {
    originalLlamaUrl = process.env[ODAI_LLAMA_URL_ENV_VAR]
    const closedPort = await reserveClosedPort()
    process.env[ODAI_LLAMA_URL_ENV_VAR] = `http://127.0.0.1:${closedPort}`
    originalAppleFmShim = process.env[ODAI_APPLE_FM_SHIM_ENV_VAR]
    const mockDir = await mkdtemp(path.join(os.tmpdir(), 'odai-registry-'))
    const mockShimPath = path.join(mockDir, 'apple-fm-mock-shim.mjs')
    await writeFile(mockShimPath, APPLE_FM_MOCK_SHIM_SOURCE)
    process.env[ODAI_APPLE_FM_SHIM_ENV_VAR] = mockShimPath
    // Point Chrome resolution at a path that cannot exist, so registry
    // results don't depend on this machine having Chrome plus a downloaded
    // on-device model.
    originalChrome = process.env[ODAI_CHROME_ENV_VAR]
    process.env[ODAI_CHROME_ENV_VAR] = path.join(mockDir, 'no-chrome-here')
  })

  afterAll(() => {
    if (originalLlamaUrl === undefined) {
      delete process.env[ODAI_LLAMA_URL_ENV_VAR]
    } else {
      process.env[ODAI_LLAMA_URL_ENV_VAR] = originalLlamaUrl
    }
    if (originalAppleFmShim === undefined) {
      delete process.env[ODAI_APPLE_FM_SHIM_ENV_VAR]
    } else {
      process.env[ODAI_APPLE_FM_SHIM_ENV_VAR] = originalAppleFmShim
    }
    if (originalChrome === undefined) {
      delete process.env[ODAI_CHROME_ENV_VAR]
    } else {
      process.env[ODAI_CHROME_ENV_VAR] = originalChrome
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

  it('declares all five backends and probes real engines before the simulator', () => {
    expect([...backendNames].toSorted()).toEqual([
      'apple-fm',
      'chrome-builtin',
      'llama-server',
      'simulator',
      'windows-phi-silica',
    ])
    expect(defaultProbeOrder[0]).toBe('chrome-builtin')
    expect(defaultProbeOrder[defaultProbeOrder.length - 1]).toBe('simulator')
  })

  it('reports availability per backend with a reason when unavailable', async () => {
    expect(await createBackend('simulator').availability()).toEqual({
      available: true,
    })
    const chromeBuiltin = await createBackend('chrome-builtin').availability()
    expect(chromeBuiltin.available).toBe(false)
    expect(chromeBuiltin.reason).toContain('Google Chrome not found')
    const llama = await createBackend('llama-server').availability()
    expect(llama.available).toBe(false)
    expect(llama.reason).toContain('not reachable')
    const apple = await createBackend('apple-fm').availability()
    expect(apple.available).toBe(false)
    expect(apple.reason).toContain('deviceNotEligible')
    const phiSilica = await createBackend('windows-phi-silica').availability()
    expect(phiSilica.available).toBe(false)
    expect(phiSilica.reason).toContain('Phi Silica (Copilot+)')
  })

  it('prefers the explicit backend option over env and probe', async () => {
    const backend = await selectBackend({
      backend: 'simulator',
      env: { ODAI_BACKEND: 'chrome-builtin' },
    })
    expect(backend.name).toBe('simulator')
  })

  it('accepts a caller-built backend instance when it is available', async () => {
    const custom: OdaiBackend = {
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

  it('prefers ODAI_BACKEND env over the probe order', async () => {
    ;(globalThis as { LanguageModel?: object | undefined }).LanguageModel =
      new LanguageModelSimulator()
    const backend = await selectBackend({ env: { ODAI_BACKEND: 'simulator' } })
    expect(backend.name).toBe('simulator')
  })

  it('throws with the reason when ODAI_BACKEND names an unavailable backend', async () => {
    await expect(
      selectBackend({ env: { ODAI_BACKEND: 'llama-server' } }),
    ).rejects.toThrow(/llama-server.*not reachable/s)
  })

  it('rejects an unknown ODAI_BACKEND value listing valid names', async () => {
    await expect(
      selectBackend({ env: { ODAI_BACKEND: 'gpt-42' } }),
    ).rejects.toThrow(/gpt-42.*simulator/s)
  })

  it('auto-selects chrome-builtin when a LanguageModel global is available', async () => {
    ;(globalThis as { LanguageModel?: object | undefined }).LanguageModel =
      new LanguageModelSimulator()
    const backend = await selectBackend({ env: {} })
    expect(backend.name).toBe('chrome-builtin')
  })

  it('falls through unavailable backends to the simulator in a bare runtime', async () => {
    const backend = await selectBackend({ env: {} })
    expect(backend.name).toBe('simulator')
  })

  it('aggregates every probed reason when no backend is available', async () => {
    await expect(
      selectBackend({
        env: {},
        probe: ['chrome-builtin', 'llama-server', 'apple-fm'],
      }),
    ).rejects.toThrow(/chrome-builtin.*llama-server.*apple-fm/s)
  })
})
