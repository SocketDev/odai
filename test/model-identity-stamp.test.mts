import { describe, expect, it } from 'vitest'

import { createModelFromState } from '../src/model.mts'

import { identitySchema } from './_shared/identity-schema.mts'
import { stubSession } from './_shared/session-stub.mts'

describe('model identity stamping', () => {
  function fakeState(
    backendName?: string | undefined,
    modelName?: string | undefined,
  ) {
    const session = stubSession({
      prompt: async () =>
        '{"packages":[],"recommendedVersion":"1.0.0","reasoning":"x"}',
    })
    return {
      backendName,
      cloneCapable: false,
      modelName,
      namespace: 'modern' as const,
      session,
    }
  }

  it('stamps the backend name onto structured results', async () => {
    const model = createModelFromState(fakeState('chrome-builtin'))
    const result = await model.promptStructured('{"packages":[]}', {
      prefill: '',
      retries: 0,
      schema: identitySchema,
    })
    expect(result.model).toBe('chrome-builtin')
  })

  it('prefers the detected model name over the backend name', async () => {
    const model = createModelFromState(
      fakeState('chrome-builtin', 'Gemini Nano'),
    )
    const result = await model.promptStructured('{"packages":[]}', {
      prefill: '',
      retries: 0,
      schema: identitySchema,
    })
    expect(result.model).toBe('Gemini Nano')
  })

  it('leaves model undefined for caller-built models', async () => {
    const model = createModelFromState(fakeState())
    const result = await model.promptStructured('{"packages":[]}', {
      prefill: '',
      retries: 0,
      schema: identitySchema,
    })
    expect(result.model).toBeUndefined()
  })
})
