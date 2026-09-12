import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { Plugin } from 'rolldown'

import { parse } from '../../../src/external/acorn.js'

export interface LoaderDeclaration {
  type: string
  start: number
  end: number
  declarations?: Array<{ id: { type: string; name: string } }> | undefined
}

export function acornWasmPlugin(): Plugin {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@ultrathink/acorn.rs.wasm')
  const binary = readFileSync(path.join(path.dirname(entry), 'acorn.wasm'))
  return {
    name: 'acorn-wasm-browser',
    transform(code, id) {
      if (id !== entry) {
        return undefined
      }
      return {
        __proto__: null,
        code: inlineAcornWasm(code, binary),
      }
    },
  }
}

export function inlineAcornWasm(code: string, binary: Uint8Array): string {
  const program = parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'script',
  }) as { body: LoaderDeclaration[] }
  const declarations = program.body.filter(
    node =>
      node.type === 'VariableDeclaration' &&
      node.declarations?.length === 1 &&
      ['wasmBytes', 'wasmPath'].includes(node.declarations[0]!.id.name),
  )
  if (declarations.length !== 2) {
    throw new Error(
      'The acorn WASM loader changed. Review its browser initialization before building.',
    )
  }
  const encoded = JSON.stringify(Buffer.from(binary).toString('base64'))
  const bytes = `const wasmBytes = (() => { const text = atob(${encoded}); const bytes = new Uint8Array(text.length); for (let i = 0, length = text.length; i < length; i += 1) { bytes[i] = text.charCodeAt(i); } return bytes; })();`
  // The installed Rust parser reports UTF-8 byte offsets, including Unicode comments.
  let result = Buffer.from(code)
  for (let i = declarations.length - 1; i >= 0; i -= 1) {
    const declaration = declarations[i]!
    const replacement =
      declaration.declarations![0]!.id.name === 'wasmBytes' ? bytes : ''
    result = Buffer.concat([
      result.subarray(0, declaration.start),
      Buffer.from(replacement),
      result.subarray(declaration.end),
    ])
  }
  return result.toString('utf8')
}
