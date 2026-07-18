import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLanguageModel } from '../src/session.mts'

describe('session', () => {
  let originalLanguageModel: unknown
  let originalWindow: unknown

  beforeEach(() => {
    originalLanguageModel = (
      globalThis as { LanguageModel?: unknown | undefined }
    ).LanguageModel
    originalWindow = (globalThis as { window?: unknown | undefined }).window
  })

  afterEach(() => {
    ;(globalThis as { LanguageModel?: unknown | undefined }).LanguageModel =
      originalLanguageModel
    ;(globalThis as { window?: unknown | undefined }).window = originalWindow
  })

  it('creates a modern session with full options', async () => {
    const create = vi.fn().mockResolvedValue({
      clone: vi.fn(),
      destroy: vi.fn(),
      prompt: vi.fn(),
    })
    ;(globalThis as { LanguageModel?: object | undefined }).LanguageModel = {
      async availability() {
        return 'available'
      },
      create,
    }
    const state = await createLanguageModel({
      initialPrompts: [{ content: 'sys', role: 'system' }],
      temperature: 0.5,
    })
    expect(state.namespace).toBe('modern')
    expect(state.cloneCapable).toBe(true)
    expect(create).toHaveBeenCalled()
  })

  it('falls back when full options throw', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('unsupported'))
      .mockResolvedValueOnce({ prompt: vi.fn() })
    ;(globalThis as { LanguageModel?: object | undefined }).LanguageModel = {
      async availability() {
        return 'available'
      },
      create,
    }
    const state = await createLanguageModel({
      initialPrompts: [{ content: 'sys', role: 'system' }],
    })
    expect(state.namespace).toBe('modern')
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('throws when no api is present', async () => {
    ;(globalThis as { LanguageModel?: unknown | undefined }).LanguageModel =
      undefined
    ;(globalThis as { window?: unknown | undefined }).window = undefined
    await expect(createLanguageModel()).rejects.toThrow('Chrome AI not found')
  })
})
