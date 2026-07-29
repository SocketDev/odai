import { describe, expect, it } from 'vitest'

import {
  CONTROL_TOKENS,
  formatControlTokens,
  parseControlTokens,
} from '../src/control-tokens.mts'
import type { Message } from '../src/types.mts'

describe('parseControlTokens', () => {
  it('parses system/user/model blocks with $END terminators', () => {
    const template = [
      '$SYSTEM',
      'You are terse.',
      '$END',
      '$USER',
      'Hello',
      '$END',
      '$MODEL',
      'Hi',
      '$END',
    ].join('\n')
    expect(parseControlTokens(template)).toEqual([
      { content: 'You are terse.', role: 'system' },
      { content: 'Hello', role: 'user' },
      { content: 'Hi', role: 'assistant' },
    ])
  })

  it('ends a block at the next role token without an explicit $END', () => {
    const template = ['$SYSTEM', 'be brief', '$USER', 'hi'].join('\n')
    expect(parseControlTokens(template)).toEqual([
      { content: 'be brief', role: 'system' },
      { content: 'hi', role: 'user' },
    ])
  })

  it('preserves multi-line block content, trimming outer blank lines', () => {
    const template = ['$USER', '', 'line one', 'line two', '', '$END'].join(
      '\n',
    )
    expect(parseControlTokens(template)).toEqual([
      { content: 'line one\nline two', role: 'user' },
    ])
  })

  it('drops empty blocks and ignores text before the first token', () => {
    const template = ['stray', '$SYSTEM', '$END', '$USER', 'ask', '$END'].join(
      '\n',
    )
    expect(parseControlTokens(template)).toEqual([
      { content: 'ask', role: 'user' },
    ])
  })

  it('returns no messages for a template with no tokens', () => {
    expect(parseControlTokens('just text')).toEqual([])
  })
})

describe('formatControlTokens', () => {
  it('renders each message as a token block', () => {
    const messages: Message[] = [
      { content: 'sys', role: 'system' },
      { content: 'q', role: 'user' },
      { content: 'a', role: 'assistant' },
    ]
    expect(formatControlTokens(messages)).toBe(
      [
        '$SYSTEM',
        'sys',
        '$END',
        '$USER',
        'q',
        '$END',
        '$MODEL',
        'a',
        '$END',
      ].join('\n'),
    )
  })

  it('round-trips through parseControlTokens', () => {
    const messages: Message[] = [
      { content: 'be brief', role: 'system' },
      { content: 'hello', role: 'user' },
    ]
    expect(parseControlTokens(formatControlTokens(messages))).toEqual(messages)
  })
})

describe('CONTROL_TOKENS', () => {
  it('exposes the Chrome On-Device Internals token set', () => {
    expect(CONTROL_TOKENS).toEqual({
      end: '$END',
      model: '$MODEL',
      system: '$SYSTEM',
      user: '$USER',
    })
  })
})
