import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { inlineAcornWasm } from '../../../../.config/repo/rolldown-plugin/acorn.mts'

describe('browser acorn WASM loader', () => {
  it('executes the installed parser without Node filesystem or module globals', () => {
    const require = createRequire(import.meta.url)
    const filename = require.resolve('@ultrathink/acorn.rs.wasm')
    const binary = readFileSync(path.join(path.dirname(filename), 'acorn.wasm'))
    const source = inlineAcornWasm(readFileSync(filename, 'utf8'), binary)
    const exports = {} as { parse: (code: string, options: object) => unknown }
    runInNewContext(
      source,
      { exports, module: { exports }, TextDecoder, TextEncoder, atob },
      { timeout: 5000 },
    )
    expect(
      exports.parse('const message = `Hello ${name}`', {
        sourceType: 'module',
      }),
    ).toMatchObject({
      type: 'Program',
      body: [{ type: 'VariableDeclaration' }],
    })
    expect(() => exports.parse('const invalid = ;', {})).toThrow()
  })

  it('rejects an unrecognized loader instead of emitting browser code with Node dependencies', () => {
    expect(() =>
      inlineAcornWasm('exports.parse = parser', new Uint8Array()),
    ).toThrow('loader changed')
  })
})
