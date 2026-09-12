import { describe, expect, it } from 'vitest'

import {
  callsSymbol,
  hasInterpolatedTemplateLiteral,
  hasLooseEquality,
  hasStrictEquality,
  importsSymbol,
  isTemplateLiteralPatch,
  isValidJavaScript,
  repairResolvesLintErrors,
} from '../../../../src/bench/verify-oracles.mts'

describe('JavaScript verification oracles', () => {
  it('uses JavaScript grammar instead of counting braces in strings and comments', () => {
    expect(isValidJavaScript("const text = '}'; // {\n")).toBe(true)
    expect(isValidJavaScript('const text = ;')).toBe(false)
    expect(isValidJavaScript('function incomplete() {')).toBe(false)
  })

  it('only recognizes equality operators in expressions', () => {
    expect(hasLooseEquality("const note = 'a == b'; // x != y\n")).toBe(false)
    expect(hasLooseEquality('const same = left == right')).toBe(true)
    expect(hasLooseEquality('const different = left != right')).toBe(true)
    expect(hasLooseEquality('const same = left === right')).toBe(false)
    expect(hasStrictEquality('const note = "==="')).toBe(false)
    expect(hasStrictEquality('const same = left === right')).toBe(true)
  })

  it('recognizes local import bindings across aliases and multiline declarations', () => {
    expect(
      importsSymbol("import {\n readFile as read\n} from 'node:fs'", 'read'),
    ).toBe(true)
    expect(
      importsSymbol("import { readFile as read } from 'node:fs'", 'readFile'),
    ).toBe(false)
    expect(importsSymbol("import read from 'reader'", 'read')).toBe(true)
    expect(importsSymbol("import * as read from 'reader'", 'read')).toBe(true)
    expect(
      importsSymbol(
        "// import { read } from 'reader'\nconst note = 'import read'",
        'read',
      ),
    ).toBe(false)
  })

  it('recognizes real calls and interpolations while ignoring examples inside strings', () => {
    expect(callsSymbol("const note = 'join(a, b)'", 'join')).toBe(false)
    expect(callsSymbol('join(a, b)', 'join')).toBe(true)
    expect(callsSymbol('object.join(a, b)', 'join')).toBe(false)
    expect(
      hasInterpolatedTemplateLiteral('const text = "`Hello ${name}`"'),
    ).toBe(false)
    expect(hasInterpolatedTemplateLiteral('const text = `Hello`')).toBe(false)
    expect(hasInterpolatedTemplateLiteral('const text = `Hello ${name}`')).toBe(
      true,
    )
  })

  it('checks all supplied lint failures against parsed code', () => {
    const lint = "'unused' is declared but its value is never used"
    expect(
      repairResolvesLintErrors(
        { fixed: "// import unused\nconst text = '} =='" },
        lint,
      ),
    ).toBe(true)
    expect(
      repairResolvesLintErrors(
        { fixed: "import {\n unused\n} from 'module'" },
        lint,
      ),
    ).toBe(false)
    expect(repairResolvesLintErrors({ fixed: 'const same = a == b' }, '')).toBe(
      false,
    )
    expect(repairResolvesLintErrors({ fixed: 'const same = ;' }, '')).toBe(
      false,
    )
  })
})

describe('template-literal patch verification', () => {
  it('does not count an existing untouched template as a new template conversion', () => {
    const original = 'const text = `Hello ${name}`\nconst count = 1\n'
    const patch =
      '--- a/greet.js\n+++ b/greet.js\n@@ -2 +2 @@\n-const count = 1\n+const count = 2\n'
    expect(isTemplateLiteralPatch({ patch }, original)).toBe(false)
  })

  it('applies partial hunks to the original before checking complete-file syntax', () => {
    const original = 'function greet(name) {\n  return "Hello " + name\n}\n'
    const prefix =
      '--- a/greet.js\n+++ b/greet.js\n@@ -2 +2 @@\n-  return "Hello " + name\n+'
    expect(
      isTemplateLiteralPatch(
        { patch: `${prefix}  return \`Hello \${name}\`\n` },
        original,
      ),
    ).toBe(true)
    expect(
      isTemplateLiteralPatch(
        {
          patch: `${prefix}import value from 'module'; const text = \`Hello \${name}\`\n`,
        },
        original,
      ),
    ).toBe(false)
    expect(
      isTemplateLiteralPatch(
        { patch: `${prefix}  return \`Hello \${name}\`\n` },
        'const other = 1',
      ),
    ).toBe(false)
  })

  const prefix =
    '--- a/greet.js\n+++ b/greet.js\n@@ -1 +1 @@\n-const text = "Hello " + name\n+'

  it('accepts a well-formed replacement with an interpolated template literal', () => {
    expect(
      isTemplateLiteralPatch({
        patch: `${prefix}const text = \`Hello \${name}\`\n`,
      }),
    ).toBe(true)
  })

  it('rejects syntax errors, comment examples, strings, and incorrect hunk counts', () => {
    expect(
      isTemplateLiteralPatch({
        patch: `${prefix}const text = \`Hello \${name}\` +\n`,
      }),
    ).toBe(false)
    expect(
      isTemplateLiteralPatch({ patch: `${prefix}// \`Hello \${name}\`\n` }),
    ).toBe(false)
    expect(
      isTemplateLiteralPatch({
        patch: `${prefix}const text = '\`Hello \${name}\`'\n`,
      }),
    ).toBe(false)
    expect(
      isTemplateLiteralPatch({
        patch: `${prefix}const text = \`Hello \${name}\`\n+extra\n`,
      }),
    ).toBe(false)
  })
})
