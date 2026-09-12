import { describe, expect, it, vi } from 'vitest'

import { createSimulatorBackend } from '../src/backends/simulator.mts'
import { runEval } from '../src/bench/index.mts'
import { createBenchResponseRules } from '../src/bench/simulator.mts'
import {
  cloneSession,
  createModelFromState,
  createOdaiModel,
  destroySession,
  detectSessionModelName,
} from '../src/model.mts'
import type { LanguageModelState } from '../src/model.mts'
import type { OdaiBackend } from '../src/backends/types.mts'
import type { Message, SessionLike } from '../src/types.mts'

import { stubSession } from './_shared/session-stub.mts'

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

  it('runs the full bench battery through the session interface', async () => {
    const model = await createOdaiModel({
      backend: createSimulatorBackend({
        fallback: '{"summary":"fallback"}',
        rules: createBenchResponseRules(),
      }),
    })
    const report = await runEval({ model })
    expect(report.total).toBeGreaterThan(0)
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
      .mockResolvedValue(session)
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
    expect(create).toHaveBeenCalledTimes(3)
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
    const clone = stubSession({ prompt: async () => 'cloned' })
    const base = stubSession({
      clone: () => clone,
      prompt: async () => 'base',
    })
    const state: LanguageModelState = {
      cloneCapable: true,
      namespace: 'modern',
      session: base,
    }
    expect(await cloneSession(state)).toBe(clone)
  })

  it('returns the base session when cloning is not available', async () => {
    const base = stubSession({ prompt: async () => 'base' })
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
    destroySession(
      stubSession({
        destroy: () => {
          destroyed = true
        },
      }),
    )
    expect(destroyed).toBe(true)
    expect(() => destroySession(stubSession())).not.toThrow()
  })
})

describe('createModelFromState', () => {
  it('creates isolated sessions when the backend cannot clone', async () => {
    const destroyed = vi.fn()
    let calls = 0
    const factory = vi.fn(async () =>
      stubSession({
        destroy: destroyed,
        prompt: async () => {
          calls += 1
          return calls === 1 ? '' : '{"ok":true}'
        },
      }),
    )
    const base = stubSession()
    const model = createModelFromState(
      { cloneCapable: false, namespace: 'modern', session: base },
      factory,
    )
    expect(
      (
        await model.promptStructured('go', {
          prefill: '',
          schema: { parse: value => value },
        })
      ).ok,
    ).toBe(true)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(destroyed).toHaveBeenCalledTimes(2)
    expect(model.rawSession()).toBe(base)
  })

  it('preserves a borrowed base session across structured and streaming calls', async () => {
    let destroyed = false
    const session = stubSession({
      destroy: () => {
        destroyed = true
      },
      prompt: async () => {
        if (destroyed) {
          throw new Error('destroyed session')
        }
        return '{"ok":true}'
      },
      promptStreaming: () =>
        (async function* () {
          if (destroyed) {
            throw new Error('destroyed session')
          }
          yield 'ready'
        })(),
    })
    const model = createModelFromState({
      cloneCapable: false,
      namespace: 'modern',
      session,
    })
    const result = await model.promptStructured('go', {
      prefill: '',
      retries: 0,
      schema: { parse: value => value },
    })
    expect(result.ok).toBe(true)
    expect(await model.promptStreaming('again')).toEqual({ raw: 'ready' })
    expect(await model.promptStreaming('again')).toEqual({ raw: 'ready' })
    expect(destroyed).toBe(false)
  })

  it('destroys the per-request clone after a structured prompt', async () => {
    let destroyed = 0
    const session = stubSession({
      clone: () =>
        stubSession({
          destroy: () => {
            destroyed += 1
          },
          prompt: async () => '{"ok":true}',
        }),
      prompt: async () => '{"ok":true}',
    })
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

describe('detectSessionModelName', () => {
  it('probes a disposable session and leaves the base untouched', async () => {
    const basePrompt = vi.fn(async () => '')
    const destroy = vi.fn()
    const session = stubSession({ prompt: basePrompt })
    const state = { cloneCapable: false, namespace: 'modern' as const, session }
    const name = await detectSessionModelName(state, async () =>
      stubSession({
        destroy,
        prompt: async () => 'Gemma 4',
      }),
    )
    expect(name).toBe('Gemma 4')
    expect(basePrompt).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys a stalled probe at its deadline', async () => {
    vi.useFakeTimers()
    try {
      const destroy = vi.fn()
      const session = stubSession()
      const pending = detectSessionModelName(
        { cloneCapable: false, namespace: 'modern', session },
        async () =>
          stubSession({
            destroy,
            prompt: () => new Promise(() => {}),
          }),
        10,
      )
      await vi.advanceTimersByTimeAsync(10)
      expect(await pending).toBeUndefined()
      expect(destroy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createModelFromState retry', () => {
  it('clones a fresh session per attempt so a stateful backend never re-prompts', async () => {
    const responses = ['', '{"ok":true}']
    let attempt = 0
    let clones = 0
    const makeSession = (): SessionLike => {
      let used = false
      return {
        clone(): SessionLike {
          clones += 1
          return makeSession()
        },
        async prompt(messages: Message[]): Promise<string> {
          void messages
          // A stateful backend (Chrome's Nano) rejects a second prompt on the
          // same session; each retry MUST land on a fresh clone.
          if (used) {
            throw new Error('session already used')
          }
          used = true
          const reply = responses[attempt] ?? '{"ok":true}'
          attempt += 1
          return reply
        },
        promptStreaming(): AsyncIterable<string> {
          return (async function* generate(): AsyncGenerator<string> {
            yield ''
          })()
        },
      }
    }
    const model = createModelFromState({
      cloneCapable: true,
      namespace: 'modern',
      session: makeSession(),
    })
    const result = await model.promptStructured<{ ok: boolean }>('go', {
      prefill: '',
      schema: {
        parse(value: unknown): { ok: boolean } {
          return value as { ok: boolean }
        },
      },
    })
    expect(result.ok).toBe(true)
    expect(clones).toBeGreaterThanOrEqual(2)
  })
})
