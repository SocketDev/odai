import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isAvailableState,
  probeAvailability,
  readAvailability,
} from '../src/availability.mts'
import type { LanguageModelLike } from '../src/types.mts'

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

  it('treats a modern-namespace downloadable model as unavailable', async () => {
    ;(globalThis as { LanguageModel?: object | undefined }).LanguageModel = {
      async availability() {
        return 'downloadable'
      },
    }
    const result = await probeAvailability()
    expect(result.namespace).toBe('modern')
    expect(result.available).toBe(false)
    expect(result.cloneCapable).toBe(true)
  })
})

describe('isAvailableState', () => {
  it('accepts both available spellings', () => {
    expect(isAvailableState('available')).toBe(true)
    expect(isAvailableState('readily')).toBe(true)
  })

  it('rejects other states', () => {
    expect(isAvailableState('downloadable')).toBe(false)
    expect(isAvailableState(undefined)).toBe(false)
  })
})

describe('readAvailability', () => {
  it('returns undefined when the model has no availability method', async () => {
    expect(await readAvailability({} as LanguageModelLike)).toBeUndefined()
  })

  it('passes a string availability through', async () => {
    const model = {
      async availability() {
        return 'available'
      },
    } as unknown as LanguageModelLike
    expect(await readAvailability(model)).toBe('available')
  })

  it('reads the availability field of an exotic object result', async () => {
    const model = {
      async availability() {
        return { availability: 'downloadable' }
      },
    } as unknown as LanguageModelLike
    expect(await readAvailability(model)).toBe('downloadable')
  })

  it('returns undefined for an unrecognized result shape', async () => {
    const model = {
      async availability() {
        return 42
      },
    } as unknown as LanguageModelLike
    expect(await readAvailability(model)).toBeUndefined()
  })
})
