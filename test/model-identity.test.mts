import { describe, expect, it } from 'vitest'

import { detectModelName, matchModelName } from '../src/model-identity.mts'
import { createMockSession } from '../src/node.mts'

describe('matchModelName', () => {
  it('prefers Gemma 4 over bare Gemma', () => {
    expect(matchModelName('I am Gemma 4, developed by Google DeepMind.')).toBe(
      'Gemma 4',
    )
  })

  it('matches Gemini Nano', () => {
    expect(matchModelName('I am Gemini Nano.')).toBe('Gemini Nano')
  })

  it('falls back to the family when no version is named', () => {
    expect(matchModelName('This is the Gemma model.')).toBe('Gemma')
  })

  it('is undefined for an unrecognized reply', () => {
    expect(matchModelName('I am a helpful assistant.')).toBe(undefined)
  })
})

describe('detectModelName', () => {
  it('prompts the session and returns the matched name plus raw reply', async () => {
    const identity = await detectModelName(
      createMockSession({ response: 'I am Gemma 4.' }),
    )
    expect(identity).toEqual({ name: 'Gemma 4', raw: 'I am Gemma 4.' })
  })

  it('returns an undefined name when the reply names no known model', async () => {
    const identity = await detectModelName(
      createMockSession({ response: 'dunno' }),
    )
    expect(identity).toEqual({ name: undefined, raw: 'dunno' })
  })
})
