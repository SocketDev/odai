import { describe, expect, it } from 'vitest'

import { applyOraclePatch } from '../../../../src/bench/patch.mts'

describe('benchmark patch application', () => {
  it('applies separated hunks with unchanged lines between them', () => {
    const patch =
      '--- a/value.js\n+++ b/value.js\n@@ -1 +1 @@\n-a\n+A\n@@ -3 +3 @@\n-c\n+C\n'
    expect(applyOraclePatch('a\nb\nc\n', patch)).toBe('A\nb\nC')
  })

  it('handles additions at the beginning and end of an existing file', () => {
    expect(
      applyOraclePatch(
        '',
        '--- /dev/null\n+++ b/value.js\n@@ -0,0 +1 @@\n+a\n',
      ),
    ).toBe('a')
    expect(
      applyOraclePatch(
        'b\n',
        '--- a/value.js\n+++ b/value.js\n@@ -0,0 +1 @@\n+a\n',
      ),
    ).toBe('a\nb')
    expect(
      applyOraclePatch(
        'a\n',
        '--- a/value.js\n+++ b/value.js\n@@ -1,0 +2 @@\n+b\n',
      ),
    ).toBe('a\nb')
  })

  it('rejects overlapping, stale, or inconsistent positions', () => {
    expect(
      applyOraclePatch(
        'a\n',
        '--- a/value.js\n+++ b/value.js\n@@ -1 +2 @@\n-a\n+b\n',
      ),
    ).toBeUndefined()
    expect(
      applyOraclePatch(
        'a\n',
        '--- a/value.js\n+++ b/value.js\n@@ -1 +1 @@\n-b\n+c\n',
      ),
    ).toBeUndefined()
    expect(
      applyOraclePatch(
        'a\n',
        '--- a/value.js\n+++ b/value.js\n@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-a\n+c\n',
      ),
    ).toBeUndefined()
  })
})
