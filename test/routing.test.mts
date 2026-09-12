import { describe, expect, it } from 'vitest'

import { backendForTask, preferredTaskBackend } from '../src/routing.mts'

describe('task backend routing', () => {
  it('uses the heavy backend for lockstep and patch', () => {
    expect(backendForTask('lockstep')).toBe('llama-server')
    expect(backendForTask('patch')).toBe('llama-server')
  })
  it('preserves automatic discovery for ordinary tasks', () => {
    expect(preferredTaskBackend(['summarize', 'triage'])).toBeUndefined()
  })
  it('runs a mixed batch on one sufficiently capable backend', () => {
    expect(preferredTaskBackend(['summarize', 'lockstep'])).toBe('llama-server')
  })
  it('accepts a declared explicit heavy backend', () => {
    expect(backendForTask('lockstep', { heavyBackend: 'chrome-builtin' })).toBe(
      'chrome-builtin',
    )
    expect(backendForTask('hoist', { heavyBackend: 'simulator' })).toBe(
      'chrome-builtin',
    )
  })
})
