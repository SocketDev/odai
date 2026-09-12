import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { expect, it } from 'vitest'
import { createLlamaServerBackend } from '../../src/backends/llama-server.mts'

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server requires a loopback TCP address.')
  }
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error === undefined ? resolve() : reject(error))),
  )
}

it('rejects redirects before forwarding health or inference requests', async () => {
  let forwarded = 0
  let original = 0
  const destination = createServer((_request, response) => {
    forwarded += 1
    response.end('{}')
  })
  const destinationUrl = await listen(destination)
  const redirect = createServer((_request, response) => {
    original += 1
    response.writeHead(307, { location: destinationUrl })
    response.end()
  })
  try {
    const url = await listen(redirect)
    const backend = createLlamaServerBackend({ url })
    expect((await backend.availability()).available).toBe(false)
    const session = await (await backend.languageModel()).create()
    try {
      await expect(
        session.prompt([{ role: 'user', content: 'private fixture query' }]),
      ).rejects.toThrow()
    } finally {
      session.destroy?.()
    }
    expect(original).toBe(2)
    expect(forwarded).toBe(0)
  } finally {
    await closeServer(redirect)
    await closeServer(destination)
  }
})
