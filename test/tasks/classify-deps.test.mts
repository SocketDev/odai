import { describe, expect, it } from 'vitest'

import { createMockModel } from '../../src/node.mts'
import { classifyDependencyChange } from '../../src/tasks/classify-deps.mts'

const ROUTINE_DIFF =
  '{"addedDeps":[{"name":"simple-icons","from":"^16.26.0","to":"^16.27.0","major":false,"newInstallScripts":false}],"newTransitiveCount":0,"droppedLockfileBody":true}'

describe('classifyDependencyChange', () => {
  it('returns a routine verdict for a minor bump', async () => {
    const model = createMockModel(
      '{"surprise":false,"flags":[],"note":"minor bump, no install scripts"}',
    )
    const result = await classifyDependencyChange(model, ROUTINE_DIFF)
    expect(result.ok).toBe(true)
    expect(result.data?.surprise).toBe(false)
    expect(result.data?.flags).toEqual([])
  })

  it('returns a surprise verdict with flags for a risky change', async () => {
    const model = createMockModel(
      '{"surprise":true,"flags":["new-dependency","new-install-scripts"],"note":"newly added and ships install scripts"}',
    )
    const result = await classifyDependencyChange(
      model,
      '{"addedDeps":[{"name":"left-pad","from":null,"to":"1.3.0","major":false,"newInstallScripts":true}],"newTransitiveCount":12,"droppedLockfileBody":true}',
    )
    expect(result.ok).toBe(true)
    expect(result.data?.surprise).toBe(true)
    expect(result.data?.flags).toContain('new-install-scripts')
  })

  it('normalizes synonymous keys', async () => {
    const model = createMockModel(
      '{"isSurprise":true,"signals":["major-jump"],"reason":"major version jump"}',
    )
    const result = await classifyDependencyChange(model, ROUTINE_DIFF)
    expect(result.ok).toBe(true)
    expect(result.data?.surprise).toBe(true)
    expect(result.data?.flags).toEqual(['major-jump'])
    expect(result.data?.note).toBe('major version jump')
  })
})
