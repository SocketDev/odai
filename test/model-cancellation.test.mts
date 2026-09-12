import { expect, it, vi } from 'vitest'
import { createModelFromState } from '../src/model.mts'
import type { SessionLike } from '../src/types.mts'

it.each(['structured', 'streaming'])(
  'preserves a borrowed base on late cancellation: %s',
  async mode => {
    const controller = new AbortController()
    const destroy = vi.fn()
    const prompt = vi.fn().mockResolvedValue('true')
    const session: SessionLike = {
      destroy,
      prompt,
      promptStreaming: async function* () {
        yield 'true'
      },
    }
    const model = createModelFromState(
      { cloneCapable: false, namespace: 'modern', session },
      undefined,
      controller.signal,
    )
    const pending =
      mode === 'structured'
        ? model.promptStructured('fixture', {
            prefill: '',
            schema: { parse: value => value === true },
          })
        : model.promptStreaming('fixture')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(destroy).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  },
)
