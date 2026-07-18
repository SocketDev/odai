import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { probeAvailability } from '../src/availability.mts'

describe('availability', () => {
  let originalLanguageModel: unknown
  let originalWindow: unknown

  beforeEach(() => {
    originalLanguageModel = (
      globalThis as { LanguageModel?: unknown | undefined }
    ).LanguageModel
    originalWindow = (globalThis as { window?: unknown | undefined }).window
  })

  afterEach(() => {
    vi.restoreAllMocks()
    ;(globalThis as { LanguageModel?: unknown | undefined }).LanguageModel =
      originalLanguageModel
    ;(globalThis as { window?: unknown | undefined }).window = originalWindow
  })

  it('detects modern namespace as available', async () => {
    ;(globalThis as { LanguageModel?: object | undefined }).LanguageModel = {
      async availability() {
        return 'available'
      },
    }
    const result = await probeAvailability()
    expect(result.namespace).toBe('modern')
    expect(result.available).toBe(true)
    expect(result.cloneCapable).toBe(true)
  })

  it('detects legacy namespace', async () => {
    ;(
      globalThis as {
        window?:
          | { ai?: { languageModel?: object | undefined } | undefined }
          | undefined
      }
    ).window = {
      ai: {
        languageModel: {
          capabilities() {
            return { available: 'available' }
          },
        },
      },
    }
    const result = await probeAvailability()
    expect(result.namespace).toBe('legacy')
    expect(result.available).toBe(true)
    expect(result.cloneCapable).toBe(false)
  })

  it('reports unavailable when no api is present', async () => {
    ;(globalThis as { LanguageModel?: unknown | undefined }).LanguageModel =
      undefined
    ;(globalThis as { window?: unknown | undefined }).window = undefined
    const result = await probeAvailability()
    expect(result.namespace).toBe('none')
    expect(result.available).toBe(false)
  })
})
