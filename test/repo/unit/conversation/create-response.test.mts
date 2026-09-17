import { expect, it, vi } from 'vitest'
import { createConversation } from '../../../../src/conversation/create.mts'
import type { ConversationPromptOptions } from '../../../../src/conversation/types.mts'
import { conversationFactory } from './fixture/model.mts'

const schema = {
  parse(value: unknown) {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('answer' in value) ||
      typeof value.answer !== 'number'
    ) {
      throw new TypeError('Expected numeric answer')
    }
    return { answer: value.answer }
  },
}

it('uses a nonstreaming provider fallback and commits its completed reply', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory)
  await chat.prompt('seed')
  Object.defineProperty(fixture.sessions[0]!.session, 'promptStreaming', {
    value: undefined,
  })
  expect(
    await chat.promptStreaming('fallback', { requestId: 'fallback-request' }),
  ).toEqual({
    aborted: false,
    raw: 'answer',
    requestId: 'fallback-request',
    stale: false,
  })
  expect(chat.messages()).toHaveLength(4)
  chat.destroy()
})

it('records a non-Error schema rejection without saving its invalid turn', async () => {
  const fixture = conversationFactory()
  fixture.responses.push('{}')
  const chat = await createConversation(fixture.factory)
  const rejection = 'schema rejected the model reply'
  const result = await chat.promptStructured('validate', {
    retries: 0,
    schema: {
      parse() {
        throw rejection
      },
    },
  })
  expect(result).toEqual({ error: rejection, ok: false, raw: '{}' })
  expect(chat.messages()).toEqual([])
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
  chat.destroy()
})

it('snapshots synonym mappings before a structured request reaches the queue', async () => {
  const fixture = conversationFactory()
  const pendingReply = Promise.withResolvers<string>()
  fixture.responses.push(pendingReply.promise, '{"value":42}')
  const chat = await createConversation(fixture.factory)
  const first = chat.prompt('first')
  const synonymMap = { answer: ['value'] }
  const pending = chat.promptStructured('structured', { schema, synonymMap })
  synonymMap.answer[0] = 'changed'
  pendingReply.resolve('done')
  await first
  expect(await pending).toMatchObject({ data: { answer: 42 }, ok: true })
  chat.destroy()
})

it('rejects a missing schema parser before contacting the provider', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory)
  const malformed = { schema: {} } as Parameters<
    typeof chat.promptStructured
  >[1]
  await expect(
    chat.promptStructured('invalid options', malformed),
  ).rejects.toBeInstanceOf(TypeError)
  expect(fixture.factory.create).not.toHaveBeenCalled()
  chat.destroy()
})

it('retries invalid structured output on rebuilt history and commits only validated output', async () => {
  const fixture = conversationFactory()
  fixture.responses.push('saved', 'invalid', '{"answer":42}')
  const chat = await createConversation(fixture.factory)
  await chat.prompt('initial')
  const initial = chat.messages()
  const result = await chat.promptStructured('structured', {
    schema,
    retries: 1,
  })
  expect(result).toEqual({
    ok: true,
    raw: '{"answer":42}',
    data: { answer: 42 },
  })
  expect(fixture.sessions).toHaveLength(2)
  expect(fixture.sessions[1]!.initial).toEqual(initial)
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
  expect(chat.messages()).toEqual([
    ...initial,
    { role: 'user', content: 'structured' },
    { role: 'assistant', content: result.raw },
  ])
  chat.destroy()
})

it('returns a structured failure without committing or retaining its session', async () => {
  const fixture = conversationFactory()
  fixture.responses.push('bad')
  const chat = await createConversation(fixture.factory)
  const result = await chat.promptStructured('structured', {
    schema,
    retries: 0,
  })
  expect(result).toMatchObject({
    ok: false,
    raw: 'bad',
    error: expect.any(String),
  })
  expect(chat.messages()).toEqual([])
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
  chat.destroy()
})

it('snapshots structured options and sends a prefill as an assistant prefix', async () => {
  const fixture = conversationFactory()
  const first = Promise.withResolvers<string>()
  fixture.responses.push(first.promise, '42}')
  const chat = await createConversation(fixture.factory)
  const pending = chat.prompt('first')
  const constraint = {
    type: 'object',
    properties: { answer: { type: 'number' } },
  }
  const options = {
    schema: { parse: schema.parse },
    prefill: '{"answer":',
    responseConstraint: constraint,
  }
  const structured = chat.promptStructured('next', options)
  options.prefill = 'changed'
  options.schema.parse = () => {
    throw new Error('changed parser')
  }
  constraint.properties.answer.type = 'string'
  first.resolve('ready')
  await pending
  expect(await structured).toMatchObject({
    ok: true,
    data: { answer: 42 },
    raw: '{"answer":42}',
  })
  expect(fixture.calls[1]).toEqual([
    { role: 'user', content: 'next' },
    { role: 'assistant', content: '{"answer":', prefix: true },
  ])
  expect(fixture.sessions[0]!.session.prompt).toHaveBeenLastCalledWith(
    expect.any(Array),
    expect.objectContaining({
      responseConstraint: {
        type: 'object',
        properties: { answer: { type: 'number' } },
      },
    }),
  )
  chat.destroy()
})

it.each(['abort', 'reset'] as const)(
  'does not commit when schema parsing triggers %s',
  async action => {
    const fixture = conversationFactory()
    fixture.responses.push('{"answer":42}')
    const controller = new AbortController()
    const chat = await createConversation(fixture.factory)
    const options = {
      abortSignal: controller.signal,
      schema: {
        parse(value: unknown) {
          if (action === 'abort') {
            controller.abort()
          } else {
            chat.reset([])
          }
          return schema.parse(value)
        },
      },
    }
    await expect(
      chat.promptStructured('reset while parsing', options),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(chat.messages()).toEqual([])
    expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
    chat.destroy()
  },
)

it('delivers stream chunks before completion and commits once at the end', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory)
  await chat.prompt('seed')
  let controller!: ReadableStreamDefaultController<string>
  const stream = new ReadableStream<string>({
    start(value) {
      controller = value
    },
  })
  fixture.sessions[0]!.session.promptStreaming = () => stream
  const chunkSeen = Promise.withResolvers<void>()
  const chunks: string[] = []
  const onEarlyField = vi.fn()
  const pending = chat.promptStreaming('stream', {
    earlyFieldPatterns: { answer: /"answer"\s*:\s*(true|false)/ },
    onChunk({ raw }) {
      chunks.push(raw)
      chunkSeen.resolve()
    },
    onEarlyField,
    requestId: 'request',
  })
  controller.enqueue('{"answer":true')
  await chunkSeen.promise
  expect(chat.messages()).toHaveLength(2)
  expect(chunks).toEqual(['{"answer":true'])
  expect(onEarlyField).toHaveBeenCalledOnce()
  controller.enqueue('}')
  controller.close()
  expect(await pending).toEqual({
    aborted: false,
    raw: '{"answer":true}',
    requestId: 'request',
    stale: false,
  })
  expect(chat.messages()).toHaveLength(4)
  expect(stream.locked).toBe(false)
  expect(onEarlyField).toHaveBeenCalledOnce()
  chat.destroy()
})

it('aborts a pending stream read, cancels its source, and never saves partial output', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory)
  await chat.prompt('seed')
  const seen = Promise.withResolvers<void>()
  const cancel = vi.fn()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue('partial')
    },
    cancel,
  })
  fixture.sessions[0]!.session.promptStreaming = () => stream
  const controller = new AbortController()
  const pending = chat
    .promptStreaming('stream', {
      abortSignal: controller.signal,
      onChunk() {
        seen.resolve()
      },
    })
    .catch(error => error)
  await seen.promise
  const reason = new Error('cancel streaming')
  controller.abort(reason)
  expect(await pending).toBe(reason)
  await chat.contextStatus()
  expect(cancel).toHaveBeenCalledOnce()
  expect(stream.locked).toBe(false)
  expect(chat.messages()).toHaveLength(2)
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
  chat.destroy()
})

it('does not let a reset in onChunk report later callbacks or commit', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory)
  await chat.prompt('seed')
  const cancel = vi.fn()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue('{"answer":true}')
    },
    cancel,
  })
  fixture.sessions[0]!.session.promptStreaming = () => stream
  const onEarlyField = vi.fn()
  await expect(
    chat.promptStreaming('stream', {
      earlyFieldPatterns: { answer: /"answer"\s*:\s*(true|false)/ },
      onEarlyField,
      onChunk() {
        chat.reset([])
      },
    }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(chat.messages()).toEqual([])
  expect(onEarlyField).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledOnce()
  expect(stream.locked).toBe(false)
  chat.destroy()
})

it('disposes and rolls back stream errors and bounded-output errors', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory, { maxCharacters: 20 })
  await chat.prompt('seed')
  const failure = new Error('stream failure')
  fixture.sessions[0]!.session.promptStreaming = () =>
    new ReadableStream({
      start(controller) {
        controller.error(failure)
      },
    })
  await expect(chat.promptStreaming('stream')).rejects.toBe(failure)
  expect(chat.messages()).toHaveLength(2)
  expect(fixture.sessions[0]!.session.destroy).toHaveBeenCalledOnce()
  await expect(chat.promptStreaming('stream')).rejects.toMatchObject({
    code: 'CONVERSATION_LIMIT',
  })
  expect(fixture.sessions[1]!.session.destroy).toHaveBeenCalledOnce()
  expect(chat.messages()).toHaveLength(2)
  chat.destroy()
})

it('rejects per-turn system instructions and invalid structured retry counts', async () => {
  const fixture = conversationFactory()
  const chat = await createConversation(fixture.factory)
  const options = { systemPrompt: 'replace' } as ConversationPromptOptions
  await expect(chat.prompt('text', options)).rejects.toBeInstanceOf(TypeError)
  await expect(chat.promptStreaming('stream', options)).rejects.toBeInstanceOf(
    TypeError,
  )
  await expect(
    chat.promptStructured('structured', { ...options, schema }),
  ).rejects.toBeInstanceOf(TypeError)
  await expect(
    chat.promptStructured('structured', { schema, retries: 6 }),
  ).rejects.toBeInstanceOf(TypeError)
  expect(fixture.factory.create).not.toHaveBeenCalled()
  chat.destroy()
})
