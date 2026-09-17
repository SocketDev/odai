import { createConversation } from '../conversation/create.mts'
import type { Conversation } from '../conversation/types.mts'
import type { LanguageModelLike, Message } from '../types.mts'
import type { ContextInput, ContextSample } from './context.mts'

export async function compareConversationPair(
  factory: LanguageModelLike,
  options: ContextInput,
  pair: number,
): Promise<ContextSample[]> {
  const opts = { __proto__: null, ...options } as typeof options
  const fixture = conversationFixture(pair, opts.contextLines)
  const replay: LanguageModelLike = {
    contextMode: 'replay',
    availability: () => factory.availability(),
    create: creationOptions => factory.create(creationOptions),
  }
  const persistent = await createConversation(factory, {
    initialPrompts: fixture.initialPrompts,
  })
  const samples: ContextSample[] = []
  try {
    for (let turn = 0, { length } = fixture.turns; turn < length; turn += 1) {
      const current = fixture.turns[turn]!
      const committed = persistent.messages()
      const contextCharacters = committed.reduce(
        (total, message) => total + message.content.length,
        current.prompt.length,
      )
      const modes =
        (pair + turn) % 2 === 0
          ? (['fresh', 'persistent'] as const)
          : (['persistent', 'fresh'] as const)
      for (
        let index = 0, modeCount = modes.length;
        index < modeCount;
        index += 1
      ) {
        const mode = modes[index]!
        const conversation =
          mode === 'persistent'
            ? persistent
            : await createConversation(replay, {
                initialPrompts: committed,
              })
        try {
          const result = await measureConversationTurn(
            conversation,
            current.prompt,
            opts.timeoutMs,
          )
          const status = await conversation.contextStatus()
          samples.push({
            ...result,
            contextCharacters,
            contextUsage: status.contextUsage,
            contextWindow: status.contextWindow,
            inputCharacters:
              mode === 'fresh' || turn === 0
                ? contextCharacters
                : current.prompt.length,
            mode,
            ok: result.output.trim() === current.expected,
            pair,
            setupMs: 0,
            turn,
          })
        } finally {
          if (mode === 'fresh') {
            conversation.destroy()
          }
        }
      }
    }
  } finally {
    persistent.destroy()
  }
  return samples
}

export async function compareConversations(
  factory: LanguageModelLike,
  options: ContextInput,
): Promise<{ samples: ContextSample[] }> {
  const opts = { __proto__: null, ...options } as typeof options
  if (factory.contextMode !== 'native') {
    throw new TypeError(
      'Conversation comparison requires a factory with native context support.',
    )
  }
  const samples: ContextSample[] = []
  for (let pair = 0; pair < opts.pairs; pair += 1) {
    samples.push(...(await compareConversationPair(factory, options, pair)))
  }
  return { samples }
}

export function conversationFixture(pair: number, contextLines: number) {
  const code = `ORCHID-${7919 + pair * 101}`
  const notes = Array.from(
    { length: contextLines },
    (_, index) =>
      `Reference ${index}: fixtures stay local and network access is disabled.`,
  ).join('\n')
  const initialPrompts: Message[] = [
    {
      role: 'system',
      content:
        'Reply with the exact requested code only. Retain facts from previous user turns. Reference notes:\n' +
        notes,
    },
  ]
  return {
    __proto__: null,
    initialPrompts,
    turns: [
      {
        prompt: `Remember the project code ${code}. Reply READY.`,
        expected: 'READY',
      },
      { prompt: 'What is the project code?', expected: code },
      { prompt: 'Return the project code again.', expected: code },
    ],
  }
}

export async function measureConversationTurn(
  conversation: Conversation,
  prompt: string,
  timeoutMs: number,
) {
  const controller = new AbortController()
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException('Conversation benchmark timed out.', 'TimeoutError'),
      ),
    timeoutMs,
  )
  const startedAt = performance.now()
  let firstChunkMs: number | undefined
  try {
    const result = await conversation.promptStreaming(prompt, {
      abortSignal: controller.signal,
      onChunk() {
        firstChunkMs ??= performance.now() - startedAt
      },
    })
    const totalMs = performance.now() - startedAt
    return {
      __proto__: null,
      firstChunkMs: firstChunkMs ?? totalMs,
      output: result.raw,
      totalMs,
    }
  } finally {
    clearTimeout(timer)
  }
}
