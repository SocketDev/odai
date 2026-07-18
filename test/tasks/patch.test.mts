import { describe, expect, it } from 'vitest'

import { createMockModel } from '../../src/node.mts'
import { generateCodePatch } from '../../src/tasks/patch.mts'

describe('generateCodePatch', () => {
  it('returns a code patch', async () => {
    const model = createMockModel(
      '{"patch":"--- a/file\\n+++ b/file\\n@@ -1 +1 @@\\n-old\\n+new","explanation":"replaced"}',
    )
    const result = await generateCodePatch(model, 'old', 'replace old with new')
    expect(result.ok).toBe(true)
    expect(result.data?.patch).toContain('--- a/file')
    expect(result.data?.explanation).toBe('replaced')
  })

  it('normalizes diff synonym', async () => {
    const model = createMockModel(
      '{"diff":"--- a/file\\n+++ b/file\\n@@ -1 +1 @@\\n-old\\n+new","reason":"replaced"}',
    )
    const result = await generateCodePatch(model, 'old', 'replace')
    expect(result.ok).toBe(true)
    expect(result.data?.patch).toContain('--- a/file')
  })
})
