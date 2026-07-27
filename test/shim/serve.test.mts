import { describe, expect, it } from 'vitest'

import { parseServeArgs } from '../../src/shim/serve.mts'

describe('parseServeArgs', () => {
  it('defaults to port 8402 and no explicit backend', () => {
    expect(parseServeArgs([])).toEqual({ backendName: undefined, port: 8402 })
  })

  it('reads a valid --port', () => {
    expect(parseServeArgs(['--port', '9000'])).toEqual({
      backendName: undefined,
      port: 9000,
    })
  })

  it('accepts port 0 for an OS-assigned port', () => {
    expect(parseServeArgs(['--port', '0']).port).toBe(0)
  })

  it('rejects a non-integer port', () => {
    expect(() => parseServeArgs(['--port', 'abc'])).toThrow(/not a valid port/)
  })

  it('rejects a port above the maximum', () => {
    expect(() => parseServeArgs(['--port', '70000'])).toThrow(
      /not a valid port/,
    )
  })

  it('rejects a negative port', () => {
    expect(() => parseServeArgs(['--port', '-1'])).toThrow(/not a valid port/)
  })

  it('reads a declared --backend', () => {
    expect(parseServeArgs(['--backend', 'llama-server'])).toEqual({
      backendName: 'llama-server',
      port: 8402,
    })
  })

  it('rejects an undeclared --backend', () => {
    expect(() => parseServeArgs(['--backend', 'gpt-9'])).toThrow(
      /not a declared backend/,
    )
  })

  it('rejects a missing --backend value', () => {
    expect(() => parseServeArgs(['--backend'])).toThrow(
      /not a declared backend/,
    )
  })

  it('rejects an unknown option', () => {
    expect(() => parseServeArgs(['--nope'])).toThrow(/unknown option/)
  })
})
