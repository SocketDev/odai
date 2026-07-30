import { describe, expect, it } from 'vitest'

import { backendForTask, REASONING_HEAVY_TASKS } from '../src/routing.mts'

describe('REASONING_HEAVY_TASKS', () => {
  it('includes the code-repair tasks', () => {
    expect(REASONING_HEAVY_TASKS.has('code-repair')).toBe(true)
    expect(REASONING_HEAVY_TASKS.has('code-repair-lint-errors')).toBe(true)
  })
})

describe('backendForTask', () => {
  it('routes a reasoning-heavy task to the heavy backend', () => {
    expect(backendForTask('code-repair')).toBe('llama-server')
    expect(backendForTask('code-repair-lint-errors')).toBe('llama-server')
  })

  it('routes everything else to the built-in on-device backend', () => {
    expect(backendForTask('security-fix')).toBe('chrome-builtin')
    expect(backendForTask('hoist')).toBe('chrome-builtin')
  })

  it('honors an override heavy backend', () => {
    expect(backendForTask('code-repair', { heavyBackend: 'vllm' })).toBe('vllm')
  })

  it('ignores the override for a non-heavy task', () => {
    expect(backendForTask('hoist', { heavyBackend: 'vllm' })).toBe(
      'chrome-builtin',
    )
  })
})
