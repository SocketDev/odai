import { afterEach, expect, it, vi } from 'vitest'
import { probeBackendAvailability } from '../src/availability.mts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('discovers a local Node server without a builtin LanguageModel global', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')))
  expect(await probeBackendAvailability({ backend: 'llama-server' })).toEqual({
    available: true,
    backend: 'llama-server',
  })
})
it('does not call the simulator available for production', async () => {
  expect(await probeBackendAvailability({ backend: 'simulator' })).toEqual({
    available: false,
  })
})
it('preserves caller cancellation distinctly from unavailability', async () => {
  await expect(
    probeBackendAvailability({ abortSignal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ name: 'AbortError' })
})
