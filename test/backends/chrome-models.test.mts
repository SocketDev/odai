import { describe, expect, it } from 'vitest'

import {
  enabledLabsExperiments,
  isChromeModelKey,
  modelUnsupportedReason,
  ODAI_CHROME_MODEL_ENV_VAR,
  parseChromeMajorVersion,
  readEnvChromeModel,
} from '../../src/backends/chrome-models.mts'

describe('isChromeModelKey', () => {
  it('accepts declared model keys', () => {
    expect(isChromeModelKey('geminiNano')).toBe(true)
    expect(isChromeModelKey('gemma4')).toBe(true)
  })

  it('rejects an undeclared key', () => {
    expect(isChromeModelKey('gemma5')).toBe(false)
    expect(isChromeModelKey('__proto__')).toBe(false)
  })
})

describe('enabledLabsExperiments', () => {
  it('omits the Gemma 4 flag by default', () => {
    const flags = enabledLabsExperiments()
    expect(flags).toContain('prompt-api-for-gemini-nano@1')
    expect(flags).not.toContain('gemma4-for-built-in-ai@1')
  })

  it('adds the Gemma 4 flag when that model is named', () => {
    const flags = enabledLabsExperiments({ model: 'gemma4' })
    expect(flags).toContain('prompt-api-for-gemini-nano@1')
    expect(flags).toContain('gemma4-for-built-in-ai@1')
  })
})

describe('readEnvChromeModel', () => {
  it('falls back to the default when unset or empty', () => {
    expect(readEnvChromeModel({})).toBe('geminiNano')
    expect(readEnvChromeModel({ [ODAI_CHROME_MODEL_ENV_VAR]: '' })).toBe(
      'geminiNano',
    )
  })

  it('reads a declared model key', () => {
    expect(readEnvChromeModel({ [ODAI_CHROME_MODEL_ENV_VAR]: 'gemma4' })).toBe(
      'gemma4',
    )
  })

  it('throws on an unrecognized model rather than falling back', () => {
    expect(() =>
      readEnvChromeModel({ [ODAI_CHROME_MODEL_ENV_VAR]: 'gemma9' }),
    ).toThrow(Error)
  })
})

describe('parseChromeMajorVersion', () => {
  it('reads the major from a Chrome version line', () => {
    expect(parseChromeMajorVersion('Google Chrome 154.0.8025.0 dev')).toBe(154)
    expect(parseChromeMajorVersion('Google Chrome 152.0.7977.65 ')).toBe(152)
  })

  it('returns undefined when no version is present', () => {
    expect(parseChromeMajorVersion('')).toBeUndefined()
    expect(parseChromeMajorVersion('not a version')).toBeUndefined()
  })
})

describe('modelUnsupportedReason', () => {
  it('passes the default model on any Chrome', () => {
    expect(
      modelUnsupportedReason('geminiNano', 120, '/path/to/chrome'),
    ).toBeUndefined()
    expect(
      modelUnsupportedReason('geminiNano', undefined, '/path/to/chrome'),
    ).toBeUndefined()
  })

  it('passes Gemma 4 on a new enough Chrome', () => {
    expect(
      modelUnsupportedReason('gemma4', 154, '/path/to/chrome'),
    ).toBeUndefined()
    expect(
      modelUnsupportedReason('gemma4', 153, '/path/to/chrome'),
    ).toBeUndefined()
  })

  it('blocks Gemma 4 on an older Chrome, naming both versions', () => {
    const reason = modelUnsupportedReason('gemma4', 152, '/path/to/chrome')
    expect(reason).toContain('152')
    expect(reason).toContain('153')
    expect(reason).toContain('/path/to/chrome')
  })

  it('blocks Gemma 4 when the Chrome version cannot be read', () => {
    expect(
      modelUnsupportedReason('gemma4', undefined, '/path/to/chrome'),
    ).toBeDefined()
  })
})
