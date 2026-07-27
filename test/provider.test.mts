import { describe, expect, it, vi } from 'vitest'

import { createSimulatorBackend } from '../src/backends/simulator.mts'
import {
  createLocalLanguageModelFactory,
  isLanguageModelFactory,
} from '../src/provider.mts'
import type { OdaiBackend } from '../src/backends/types.mts'
import type { SessionLike } from '../src/types.mts'

describe('createLocalLanguageModelFactory', () => {
  it('exposes a socket-lib LanguageModelFactory shape', () => {
    const factory = createLocalLanguageModelFactory({
      backend: createSimulatorBackend(),
    })
    expect(isLanguageModelFactory(factory)).toBe(true)
  })

  it('reports available when a backend can be selected', async () => {
    const factory = createLocalLanguageModelFactory({
      backend: createSimulatorBackend(),
    })
    expect(await factory.availability()).toBe('available')
  })

  it('creates a session that routes through the selected backend', async () => {
    const factory = createLocalLanguageModelFactory({
      backend: createSimulatorBackend({ fallback: '{"ok":true}' }),
    })
    const session = (await factory.create()) as SessionLike
    expect(await session.prompt([{ content: 'hi', role: 'user' }])).toBe(
      '{"ok":true}',
    )
  })

  it('reports unavailable when no backend can be selected', async () => {
    const backend: OdaiBackend = {
      async availability() {
        return { available: false, reason: 'no engine' }
      },
      async languageModel() {
        throw new Error('should not be reached')
      },
      name: 'simulator',
    }
    const factory = createLocalLanguageModelFactory({ backend })
    expect(await factory.availability()).toBe('unavailable')
  })

  it('selects the backend once and reuses it across availability and create', async () => {
    const inner = createSimulatorBackend()
    const availabilitySpy = vi.fn(() => inner.availability())
    const languageModelSpy = vi.fn(() => inner.languageModel())
    const backend: OdaiBackend = {
      availability: availabilitySpy,
      languageModel: languageModelSpy,
      name: 'simulator',
    }
    const factory = createLocalLanguageModelFactory({ backend })
    expect(await factory.availability()).toBe('available')
    await factory.create()
    expect(availabilitySpy).toHaveBeenCalledTimes(1)
    expect(languageModelSpy).toHaveBeenCalledTimes(1)
  })
})
