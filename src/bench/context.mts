import type { Message } from '../types.mts'

export interface ContextFactory {
  create(options: {
    initialPrompts: Message[]
    signal: AbortSignal
  }): Promise<ContextSession>
}

export interface ContextSession {
  contextUsage?: number | undefined
  contextWindow?: number | undefined
  destroy(): void
  promptStreaming(
    prompt: string,
    options: { signal: AbortSignal },
  ): ReadableStream<string>
}

export interface ContextInput {
  contextLines: number
  pairs: number
  timeoutMs: number
}

export interface ContextSample {
  contextCharacters: number
  contextUsage: number | undefined
  contextWindow: number | undefined
  firstChunkMs: number
  inputCharacters: number
  mode: 'fresh' | 'persistent'
  ok: boolean
  output: string
  pair: number
  setupMs: number
  totalMs: number
  turn: number
}

export interface ContextReport {
  samples: ContextSample[]
  userAgent: string
}

export interface ContextResponse {
  firstChunkMs: number
  output: string
  promptMs: number
}

/**
 * This function runs inside Chrome. Keep runtime dependencies in its closure.
 */
export async function compareContextSessions(
  options: ContextInput,
): Promise<ContextReport> {
  const opts = { __proto__: null, ...options } as typeof options
  const nativeFactory = (
    globalThis as typeof globalThis & {
      LanguageModel?: ContextFactory | undefined
    }
  ).LanguageModel
  if (nativeFactory === undefined) {
    throw new Error('The context benchmark requires Chrome LanguageModel.')
  }
  const factory = nativeFactory

  function destroySession(session: ContextSession): void {
    try {
      session.destroy()
    } catch {
      /* Cleanup must preserve an earlier creation or generation failure. */
    }
  }

  function withDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    disposeLate?: ((value: T) => void) | undefined,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        const error = new DOMException(
          'Context operation timed out.',
          'TimeoutError',
        )
        reject(error)
        controller.abort(error)
      }, opts.timeoutMs)
      Promise.resolve()
        .then(() => operation(controller.signal))
        .then(
          value => {
            if (settled) {
              disposeLate?.(value)
              return
            }
            settled = true
            clearTimeout(timer)
            resolve(value)
          },
          error => {
            if (!settled) {
              settled = true
              clearTimeout(timer)
              reject(error)
            }
          },
        )
    })
  }

  function createSession(initialPrompts: Message[]): Promise<ContextSession> {
    return withDeadline(
      signal =>
        factory.create({
          initialPrompts: initialPrompts.map(message => ({ ...message })),
          signal,
        }),
      destroySession,
    )
  }

  async function readResponse(
    session: ContextSession,
    prompt: string,
    signal: AbortSignal,
  ): Promise<ContextResponse> {
    const promptAt = performance.now()
    const reader = session.promptStreaming(prompt, { signal }).getReader()
    let cancelled = false
    let completed = false
    let firstChunkMs: number | undefined
    let output = ''
    function cancelReader(): void {
      if (!cancelled) {
        cancelled = true
        void reader.cancel(signal.reason).catch(() => undefined)
      }
    }
    function abort(): void {
      signal.removeEventListener('abort', abort)
      cancelReader()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      while (true) {
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) {
          completed = true
          break
        }
        firstChunkMs ??= performance.now() - promptAt
        output += chunk.value
      }
      const promptMs = performance.now() - promptAt
      return { firstChunkMs: firstChunkMs ?? promptMs, output, promptMs }
    } finally {
      signal.removeEventListener('abort', abort)
      if (!completed) {
        cancelReader()
      }
      reader.releaseLock()
    }
  }

  async function comparePair(pair: number): Promise<ContextSample[]> {
    const secret = `ORCHID-${7919 + pair * 101}`
    const context = Array.from(
      { length: opts.contextLines },
      (_, index) =>
        `Reference ${index}: fixtures stay local and network access is disabled.`,
    ).join('\n')
    const initial: Message[] = [
      {
        role: 'system',
        content:
          'Reply with the exact requested code only. Retain facts from previous user turns. Reference notes:\n' +
          context,
      },
    ]
    const transcript: Message[] = [...initial]
    const turns = [
      {
        prompt: `Remember the project code ${secret}. Reply READY.`,
        expected: 'READY',
      },
      { prompt: 'What is the project code?', expected: secret },
      { prompt: 'Return the project code again.', expected: secret },
    ]
    const opening = performance.now()
    const persistent = await createSession(initial)
    const persistentSetupMs = performance.now() - opening
    const samples: ContextSample[] = []
    try {
      for (let turn = 0, length = turns.length; turn < length; turn += 1) {
        const current = turns[turn]!
        const modes =
          (pair + turn) % 2 === 0
            ? (['fresh', 'persistent'] as const)
            : (['persistent', 'fresh'] as const)
        const contextCharacters = transcript.reduce(
          (total, message) => total + message.content.length,
          current.prompt.length,
        )
        let committed = ''
        for (
          let index = 0, modeCount = modes.length;
          index < modeCount;
          index += 1
        ) {
          const mode = modes[index]!
          const startedAt = performance.now()
          const session =
            mode === 'persistent' ? persistent : await createSession(transcript)
          const setupMs =
            mode === 'persistent'
              ? turn === 0
                ? persistentSetupMs
                : 0
              : performance.now() - startedAt
          try {
            const result = await withDeadline(signal =>
              readResponse(session, current.prompt, signal),
            )
            samples.push({
              contextCharacters,
              contextUsage: session.contextUsage,
              contextWindow: session.contextWindow,
              firstChunkMs: result.firstChunkMs,
              inputCharacters:
                mode === 'fresh' || turn === 0
                  ? contextCharacters
                  : current.prompt.length,
              mode,
              ok: result.output.trim() === current.expected,
              output: result.output,
              pair,
              setupMs,
              totalMs: setupMs + result.promptMs,
              turn,
            })
            if (mode === 'persistent') {
              committed = result.output
            }
          } finally {
            if (mode === 'fresh') {
              destroySession(session)
            }
          }
        }
        // Both modes receive exactly the native conversation's completed history.
        transcript.push(
          { role: 'user', content: current.prompt },
          { role: 'assistant', content: committed },
        )
      }
    } finally {
      destroySession(persistent)
    }
    return samples
  }

  const samples: ContextSample[] = []
  for (let pair = 0; pair < opts.pairs; pair += 1) {
    samples.push(...(await comparePair(pair)))
  }
  return { samples, userAgent: globalThis.navigator.userAgent }
}
