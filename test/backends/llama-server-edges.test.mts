import { afterEach, expect, test, vi } from 'vitest'

import {
  assertLoopbackUrl,
  createLlamaServerBackend,
  readErrorDetail,
  streamChat,
} from '../../src/backends/llama-server.mts'

const config = {
  healthTimeoutMs: 1000,
  model: undefined,
  requestTimeoutMs: 1000,
  url: 'http://127.0.0.1:8080',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test.each([
  'file:///tmp/model',
  'http://example-user@localhost:8080',
  'http://:example-password@localhost:8080',
])('rejects a nonlocal transport contract: %s', url => {
  expect(() => assertLoopbackUrl(url)).toThrow()
})

test('an unavailable error body yields no fabricated server detail', async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('fixture body failed'))
      },
    }),
  )
  expect(await readErrorDetail(response)).toBe('')
  expect(await readErrorDetail(new Response('  '))).toBe('')
})

test('streaming rejects an HTTP success without a response body', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(undefined, { status: 204 })),
  )
  await expect(streamChat(config, {}, []).next()).rejects.toBeInstanceOf(Error)
})

test.each(['', 'data: [DONE]', 'data: {"choices":[]}'])(
  'streaming accepts a terminal tail without a text delta: %s',
  tail => {
    return (async () => {
      const response = new Response(tail)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      const chunks = []
      for await (const chunk of streamChat(config, {}, [])) {
        chunks.push(chunk)
      }
      expect(chunks).toEqual([])
      expect(response.body?.locked).toBe(false)
    })()
  },
)

test('the selected llama factory advertises available sessions', async () => {
  const backend = createLlamaServerBackend({ env: {}, url: config.url })
  const factory = await backend.languageModel()
  expect(await factory.availability?.()).toBe('available')
})
