import { describe, expect, it } from 'vitest'

import { isLockstepPatch } from '../../../../src/lockstep/patch.mts'

describe('lockstep unified patch boundaries', () => {
  it('rejects a destination that differs from the authorized path', () => {
    const patch =
      '--- a/src/value.mts\n+++ b/src/other.mts\n@@ -1 +1 @@\n-old\n+new\n'
    expect(isLockstepPatch('src/value.mts', patch)).toBe(false)
  })

  it('rejects a new hunk before the previous hunk consumes its declared lines', () => {
    const patch =
      '--- a/src/value.mts\n+++ b/src/value.mts\n@@ -1,2 +1,2 @@\n-old\n+new\n@@ -5 +5 @@\n-last\n+next\n'
    expect(isLockstepPatch('src/value.mts', patch)).toBe(false)
  })
})
