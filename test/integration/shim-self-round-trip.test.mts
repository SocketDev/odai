/**
 * @file Odai talks to llama-server and presents as one, so its own
 *   llama-server client must be able to drive its own shim. This wires the two
 *   halves together over a real loopback socket: the client's `/health` probe,
 *   its non-streaming prompt, and its SSE streaming path all run against the
 *   shim's OpenAI routes.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { createLlamaServerBackend } from '../../src/backends/llama-server.mts'
import { startShimServer } from '../../src/shim/server.mts'
import { createScriptedBackend } from '../shim/_shared/scripted-backend.mts'
import type { ShimServerHandle } from '../../src/shim/server.mts'

describe('odai over odai', () => {
  let handle: ShimServerHandle | undefined

  afterEach(async () => {
    await handle?.close()
    handle = undefined
  })

  it('drives its own shim through the llama-server backend', async () => {
    handle = await startShimServer({
      backend: createScriptedBackend(['from the shim', 'streamed reply']),
    })
    const client = createLlamaServerBackend({ env: {}, url: handle.url })

    expect(await client.availability()).toEqual({ available: true })

    const factory = await client.languageModel()
    const session = await factory.create({ systemPrompt: 'be terse' })
    expect(await session.prompt([{ content: 'hi', role: 'user' }])).toBe(
      'from the shim',
    )

    const pieces: string[] = []
    for await (const piece of session.promptStreaming([
      { content: 'again', role: 'user' },
    ])) {
      pieces.push(piece)
    }
    expect(pieces.join('')).toBe('streamed reply')
  })
})
