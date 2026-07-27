import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildCreateOptions,
  createLanguageModel,
  createWithFallback,
  isUnsupportedError,
} from '../src/session.mts'
import type { LanguageModelLike } from '../src/types.mts'

describe('session', () => {
  let originalLanguageModel: unknown

  beforeEach(() => {
    originalLanguageModel = (
      globalThis as { LanguageModel?: unknown | undefined }
    ).LanguageModel
  })

  afterEach(() => {
    ;(globalThis as { LanguageModel?: unknown | undefined }).LanguageModel =
      originalLanguageModel
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
    await expect(createLanguageModel()).rejects.toThrow('Chrome AI not found')
  })
})

describe('buildCreateOptions', () => {
  it('prefers initialPrompts over systemPrompt', () => {
    expect(
      buildCreateOptions({
        initialPrompts: [{ content: 'sys', role: 'system' }],
        systemPrompt: 'ignored',
        temperature: 0.4,
        topK: 2,
      }),
    ).toEqual({
      initialPrompts: [{ content: 'sys', role: 'system' }],
      temperature: 0.4,
      topK: 2,
    })
  })

  it('uses systemPrompt when initialPrompts is empty', () => {
    expect(
      buildCreateOptions({ initialPrompts: [], systemPrompt: 'be terse' }),
    ).toEqual({ systemPrompt: 'be terse' })
  })

  it('returns an empty bag when nothing is provided', () => {
    expect(buildCreateOptions({})).toEqual({})
  })
})

describe('createWithFallback', () => {
  it('walks the full ladder down to the system-only options', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('full unsupported'))
      .mockRejectedValueOnce(new TypeError('initialPrompts unsupported'))
      .mockResolvedValueOnce({ prompt: vi.fn() })
    const model = { create } as unknown as LanguageModelLike
    const session = await createWithFallback(model, {
      initialPrompts: [{ content: 'sys', role: 'system' }],
      systemPrompt: 'be terse',
    })
    expect(session).toBeDefined()
    expect(create).toHaveBeenCalledTimes(3)
    expect(create.mock.calls[2]?.[0]).toEqual({ systemPrompt: 'be terse' })
  })

  it('rethrows an error that is not an unsupported-option error', async () => {
    const create = vi.fn().mockRejectedValue(new Error('network down'))
    const model = { create } as unknown as LanguageModelLike
    await expect(createWithFallback(model, {})).rejects.toThrow('network down')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('rethrows when the reduced attempt fails for a non-option reason', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('full unsupported'))
      .mockRejectedValueOnce(new Error('disk full'))
    const model = { create } as unknown as LanguageModelLike
    await expect(
      createWithFallback(model, {
        initialPrompts: [{ content: 'sys', role: 'system' }],
      }),
    ).rejects.toThrow('disk full')
    expect(create).toHaveBeenCalledTimes(2)
  })
})

describe('isUnsupportedError', () => {
  it('is true for TypeError and NotSupportedError names', () => {
    expect(isUnsupportedError(new TypeError('x'))).toBe(true)
    const named = new Error('x')
    named.name = 'NotSupportedError'
    expect(isUnsupportedError(named)).toBe(true)
  })

  it('is true when the message mentions not supported', () => {
    expect(isUnsupportedError(new Error('topK is not supported here'))).toBe(
      true,
    )
  })

  it('is false for unrelated errors and non-errors', () => {
    expect(isUnsupportedError(new Error('boom'))).toBe(false)
    expect(isUnsupportedError('not an error')).toBe(false)
  })
})
