import { describe, expect, it, vi } from 'vitest'

import { createSimulatorBackend } from '../src/backends/simulator.mts'
import { runEval } from '../src/bench/index.mts'
import { createBenchResponseRules } from '../src/bench/simulator.mts'
import {
  cloneSession,
  createModelFromState,
  createOdaiModel,
  destroySession,
} from '../src/model.mts'
import type { LanguageModelState } from '../src/model.mts'
import type { OdaiBackend } from '../src/backends/types.mts'
import type { SessionLike } from '../src/types.mts'

describe('createOdaiModel', () => {
  it('drives structured prompts through the simulator backend', async () => {
    const model = await createOdaiModel({
      backend: createSimulatorBackend({
        fallback: '{"summary":"nothing matched"}',
        rules: [
          {
            response: '```json\n{"summary":"duplicate lodash found"}\n```',
            when: text => text.includes('lodash'),
          },
        ],
      }),
      systemPrompt: 'You are a supply-chain assistant.',
    })
    const result = await model.promptStructured<{ summary: string }>(
      'dedupe lodash versions',
      {
        prefill: '{"summary":"',
        schema: {
          parse(value: unknown): { summary: string } {
            const record = value as { summary?: unknown | undefined }
            if (typeof record.summary !== 'string') {
              throw new TypeError('summary must be a string')
            }
            return { summary: record.summary }
          },
        },
      },
    )
    expect(result.ok).toBe(true)
    expect(result.data?.summary).toBe('duplicate lodash found')
  })

  it('streams raw output through the simulator backend', async () => {
    const model = await createOdaiModel({
      backend: createSimulatorBackend({ fallback: '{"ok":true}', rules: [] }),
    })
    const result = await model.promptStreaming('hello')
    expect(result.raw).toBe('{"ok":true}')
  })

  it('runs the full bench battery through the seam', async () => {
    const model = await createOdaiModel({
      backend: createSimulatorBackend({
        fallback: '{"summary":"fallback"}',
        rules: createBenchResponseRules(),
      }),
    })
    const report = await runEval({ model })
    expect(report.total).toBe(8)
    expect(report.score).toBe(1)
  })

  it('applies the session-option fallback ladder to backend factories', async () => {
    const session: SessionLike = {
      async prompt() {
        return '{"ok":true}'
      },
      promptStreaming(): AsyncIterable<string> {
        return (async function* generate(): AsyncGenerator<string> {
          yield '{"ok":true}'
        })()
      },
    }
    const create = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('temperature is not supported'))
      .mockResolvedValueOnce(session)
    const backend: OdaiBackend = {
      async availability() {
        return { available: true }
      },
      async languageModel() {
        return {
          async availability() {
            return 'available'
          },
          create,
        }
      },
      name: 'simulator',
    }
    const model = await createOdaiModel({
      backend,
      systemPrompt: 'sys',
      temperature: 0.7,
    })
    expect(create).toHaveBeenCalledTimes(2)
    const result = await model.promptStreaming('hello')
    expect(result.raw).toBe('{"ok":true}')
  })

  it('exposes the warm base session through rawSession', async () => {
    const model = await createOdaiModel({
      backend: createSimulatorBackend({ fallback: '{"ok":true}', rules: [] }),
    })
    expect(typeof model.rawSession().prompt).toBe('function')
  })
})

describe('cloneSession', () => {
  it('clones a clone-capable session', async () => {
    const clone = { prompt: async () => 'cloned' } as SessionLike
    const base: SessionLike = {
      clone: () => clone,
      async prompt() {
        return 'base'
      },
    }
    const state: LanguageModelState = {
      cloneCapable: true,
      namespace: 'modern',
      session: base,
    }
    expect(await cloneSession(state)).toBe(clone)
  })

  it('returns the base session when cloning is not available', async () => {
    const base: SessionLike = {
      async prompt() {
        return 'base'
      },
    }
    const state: LanguageModelState = {
      cloneCapable: false,
      namespace: 'modern',
      session: base,
    }
    expect(await cloneSession(state)).toBe(base)
  })
})

describe('destroySession', () => {
  it('calls destroy when present and is a no-op otherwise', () => {
    let destroyed = false
    destroySession({
      destroy: () => {
        destroyed = true
      },
      prompt: async () => 'x',
    })
    expect(destroyed).toBe(true)
    expect(() => destroySession({ prompt: async () => 'x' })).not.toThrow()
  })
})

describe('createModelFromState', () => {
  it('destroys the per-request clone after a structured prompt', async () => {
    let destroyed = 0
    const session: SessionLike = {
      clone: () => ({
        destroy: () => {
          destroyed += 1
        },
        prompt: async () => '{"ok":true}',
      }),
      async prompt() {
        return '{"ok":true}'
      },
    }
    const model = createModelFromState({
      cloneCapable: true,
      namespace: 'modern',
      session,
    })
    const result = await model.promptStructured<{ ok: boolean }>('go', {
      prefill: '{"ok":',
      schema: {
        parse(value: unknown): { ok: boolean } {
          return value as { ok: boolean }
        },
      },
    })
    expect(result.ok).toBe(true)
    expect(destroyed).toBe(1)
  })
})
