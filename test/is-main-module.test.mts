import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isMainModule } from '../src/is-main-module.mts'

describe('isMainModule', () => {
  it('is true when the module url resolves to the entry path', () => {
    const self = new URL(import.meta.url).pathname
    expect(isMainModule(import.meta.url, self)).toBe(true)
  })

  it('is false when the module url differs from the entry path', () => {
    expect(isMainModule(import.meta.url, '/definitely/not/this/file.mts')).toBe(
      false,
    )
  })

  it('is false when there is no entry path', () => {
    expect(isMainModule(import.meta.url, '')).toBe(false)
  })

  it('is false when a path cannot be realpath-resolved', () => {
    const ghost = pathToFileURL('/no/such/module.mts').href
    expect(isMainModule(ghost, '/no/such/other.mts')).toBe(false)
  })
})
