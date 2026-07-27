import { describe, expect, it } from 'vitest'

import { parseArgs } from '../../src/bench/run.mts'

describe('bench run parseArgs', () => {
  it('defaults to the simulator with no mock', () => {
    expect(parseArgs([])).toEqual({ backend: undefined, mock: false })
  })

  it('reads a declared --backend=', () => {
    expect(parseArgs(['--backend=llama-server'])).toEqual({
      backend: 'llama-server',
      mock: false,
    })
  })

  it('sets mock when --mock is present', () => {
    expect(parseArgs(['--mock'])).toEqual({ backend: undefined, mock: true })
  })

  it('combines --backend= and --mock', () => {
    expect(parseArgs(['--backend=simulator', '--mock'])).toEqual({
      backend: 'simulator',
      mock: true,
    })
  })

  it('rejects an undeclared --backend= value', () => {
    expect(() => parseArgs(['--backend=gpt-9'])).toThrow(
      /not a declared backend/,
    )
  })
})
