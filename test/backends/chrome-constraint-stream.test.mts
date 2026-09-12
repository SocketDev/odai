import { expect, test, vi } from 'vitest'

import { wrapSessionWithConstraintFallback } from '../../src/backends/chrome-constraint.mts'
import type { Message } from '../../src/types.mts'

test('constraint fallback preserves the native stream and input messages', async () => {
  const nativeStream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue('fixture chunk')
      controller.close()
    },
  })
  const promptStreaming = vi.fn().mockReturnValue(nativeStream)
  const wrapped = wrapSessionWithConstraintFallback({
    prompt: vi.fn(),
    promptStreaming,
  })
  const messages: Message[] = [{ role: 'user', content: 'fixture request' }]
  expect(wrapped.promptStreaming(messages)).toBe(nativeStream)
  expect(promptStreaming).toHaveBeenCalledWith(messages)
  const reader = nativeStream.getReader()
  expect(await reader.read()).toEqual({ done: false, value: 'fixture chunk' })
  expect(await reader.read()).toEqual({ done: true, value: undefined })
  reader.releaseLock()
})
