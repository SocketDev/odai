import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { probeAvailability } from '../src/availability.mts'

describe('availability', () => {
  let originalLanguageModel: unknown

  beforeEach(() => {
    originalLanguageModel = (
      globalThis as { LanguageModel?: unknown | undefined }
    ).LanguageModel
  })

  afterEach(() => {
    vi.restoreAllMocks()
    ;(globalThis as { LanguageModel?: unknown | undefined }).LanguageModel =
      originalLanguageModel
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

  it('reports unavailable when no api is present', async () => {
    ;(globalThis as { LanguageModel?: unknown | undefined }).LanguageModel =
      undefined
    const result = await probeAvailability()
    expect(result.namespace).toBe('none')
    expect(result.available).toBe(false)
  })
})
