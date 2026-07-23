import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  backendNames,
  createBackend,
  defaultProbeOrder,
  selectBackend,
} from '../../src/backends/registry.mts'
import { LanguageModelSimulator } from '../../src/simulator.mts'
import type { LocaiBackend } from '../../src/backends/types.mts'

describe('backend registry', () => {
  let originalLanguageModel: unknown

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
    expect(llama.reason).toContain('next phase')
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
    ).rejects.toThrow(/llama-server.*next phase/s)
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
