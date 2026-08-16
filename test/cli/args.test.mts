import { describe, expect, it } from 'vitest'

import { CliUsageError, parseCliArgs, usageText } from '../../src/cli/args.mts'

describe('parseCliArgs', () => {
  it('parses a bare command', () => {
    const args = parseCliArgs(['triage'])
    expect(args.command).toBe('triage')
    expect(args.backend).toBeUndefined()
    expect(args.help).toBe(false)
    expect(args.raw).toBe(false)
  })

  it('parses flags in both spaced and equals forms', () => {
    const args = parseCliArgs([
      'summarize',
      '--backend',
      'simulator',
      '--input=notes.txt',
      '--timeout=5000',
      '--raw',
    ])
    expect(args.backend).toBe('simulator')
    expect(args.input).toBe('notes.txt')
    expect(args.timeoutMs).toBe(5000)
    expect(args.raw).toBe(true)
  })

  it('parses patch with an instruction', () => {
    const args = parseCliArgs([
      'patch',
      '--instruction',
      'use a template literal',
    ])
    expect(args.command).toBe('patch')
    expect(args.instruction).toBe('use a template literal')
  })

  it('rejects patch without an instruction', () => {
    expect(() => parseCliArgs(['patch'])).toThrow(CliUsageError)
    expect(() => parseCliArgs(['patch'])).toThrow(/--instruction/)
  })

  it('rejects --instruction on non-patch commands', () => {
    expect(() => parseCliArgs(['triage', '--instruction', 'x'])).toThrow(
      /only applies to the patch command/,
    )
  })

  it('rejects an unknown command with the expected list', () => {
    expect(() => parseCliArgs(['deploy'])).toThrow(/unknown command "deploy"/)
  })

  it('rejects an unknown option', () => {
    expect(() => parseCliArgs(['triage', '--fast'])).toThrow(
      /unknown option --fast/,
    )
  })

  it('rejects an undeclared backend name', () => {
    expect(() => parseCliArgs(['triage', '--backend', 'gpt4'])).toThrow(
      /not a declared backend/,
    )
  })

  it('rejects a non-positive timeout', () => {
    expect(() => parseCliArgs(['triage', '--timeout', '0'])).toThrow(
      /not a positive number/,
    )
    expect(() => parseCliArgs(['triage', '--timeout', 'soon'])).toThrow(
      /not a positive number/,
    )
  })

  it('parses serve with a port in both spaced and equals forms', () => {
    expect(parseCliArgs(['serve', '--port', '8402']).port).toBe(8402)
    expect(parseCliArgs(['serve', '--port=0']).port).toBe(0)
  })

  it('rejects an invalid port', () => {
    expect(() => parseCliArgs(['serve', '--port', 'soon'])).toThrow(
      /not a valid port/,
    )
    expect(() => parseCliArgs(['serve', '--port', '65536'])).toThrow(
      /not a valid port/,
    )
    expect(() => parseCliArgs(['serve', '--port', '-1'])).toThrow(
      /not a valid port/,
    )
    expect(() => parseCliArgs(['serve', '--port'])).toThrow(/needs a value/)
  })

  it('tells the reader the expected port range', () => {
    expect(() => parseCliArgs(['serve', '--port', 'soon'])).toThrow(
      /expected an integer from 0 to 65535/,
    )
  })

  it('rejects --port on non-serve commands', () => {
    expect(() => parseCliArgs(['triage', '--port', '8402'])).toThrow(
      /only applies to the serve command/,
    )
  })

  it('rejects a flag with a missing value', () => {
    expect(() => parseCliArgs(['triage', '--backend'])).toThrow(/needs a value/)
  })

  it('rejects a second positional argument', () => {
    expect(() => parseCliArgs(['triage', 'extra'])).toThrow(
      /unexpected argument "extra"/,
    )
  })

  it('accepts --help without a command', () => {
    const args = parseCliArgs(['--help'])
    expect(args.help).toBe(true)
    expect(args.command).toBeUndefined()
  })
})

describe('usageText', () => {
  it('documents every command and the exit codes', () => {
    const text = usageText()
    for (const command of [
      'backends',
      'classify-deps',
      'commit-msg',
      'patch',
      'serve',
      'summarize',
      'triage',
    ]) {
      expect(text).toContain(command)
    }
    expect(text).toContain('69 no backend available')
  })
})
