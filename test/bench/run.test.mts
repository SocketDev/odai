import { describe, expect, it } from 'vitest'
import { benchmarkEvidence, parseArgs } from '../../src/bench/run.mts'

describe('benchmark arguments', () => {
  it('defaults to deterministic evaluation', () => {
    const args = parseArgs([])
    expect(args.backend).toBeUndefined()
    expect(args.routed).toBe(false)
    expect(args.mock).toBe(false)
  })
  it('selects explicit local evaluation with a bounded scenario', () => {
    const args = parseArgs([
      '--backend',
      'chrome-builtin',
      '--scenario=lockstep',
      '--timeout=5000',
      '--json',
    ])
    expect(args).toMatchObject({
      backend: 'chrome-builtin',
      scenario: 'lockstep',
      timeoutMs: 5000,
      json: true,
    })
  })
  it.each([
    ['--unknown'],
    ['--backend=gpt-9'],
    ['--backend'],
    ['--timeout=0'],
    ['--timeout=Infinity'],
    ['--mock', '--backend=simulator'],
    ['--routed', '--backend=chrome-builtin'],
  ])('rejects invalid arguments %j', (...args) => {
    expect(() => parseArgs(args)).toThrow()
  })
  it('supports task routing and explicit mock mode', () => {
    expect(parseArgs(['--routed']).routed).toBe(true)
    expect(parseArgs(['--mock']).mock).toBe(true)
    expect(parseArgs(['--help']).help).toBe(true)
  })
})

describe('benchmark evidence', () => {
  it.each([
    { argv: [], expected: 'simulator' },
    { argv: ['--mock'], expected: 'simulator' },
    { argv: ['--backend=simulator'], expected: 'simulator' },
    { argv: ['--routed'], expected: 'unverified' },
    { argv: ['--backend=llama-server'], expected: 'real' },
  ])('labels $argv as $expected', ({ argv, expected }) => {
    expect(benchmarkEvidence(parseArgs(argv))).toBe(expected)
  })
})
