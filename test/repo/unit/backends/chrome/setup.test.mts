import { expect, it, vi } from 'vitest'

import { setupChromeBuiltin } from '../../../../../src/backends/chrome/setup.mts'

function resolvedConfig(model: 'geminiNano' | 'gemma4') {
  return {
    allowDownload: true,
    chromePath: '/example/chrome',
    chromePathCandidates: ['/example/chrome'],
    model,
    systemChromeUserDataDir: '/example/system',
    userDataDir: `/example/odai/${model}`,
  }
}

it('provisions the selected model, verifies identity and closes every resource', async () => {
  const destroy = vi.fn()
  const close = vi.fn().mockResolvedValue(undefined)
  const createBackend = vi.fn().mockReturnValue({
    availability: vi.fn().mockResolvedValue({ available: true }),
    close,
    languageModel: vi.fn().mockResolvedValue({
      create: vi.fn().mockResolvedValue({
        destroy,
        prompt: vi.fn().mockResolvedValue('Gemma 4'),
      }),
    }),
    name: 'chrome-builtin',
  })
  await expect(
    setupChromeBuiltin(
      {
        chromePath: '/example/chrome',
        env: {},
        model: 'gemma4',
        userDataDir: '/example/odai/gemma4',
      },
      {
        createBackend,
        resolveConfig: async () => resolvedConfig('gemma4'),
      },
    ),
  ).resolves.toEqual({
    backend: 'chrome-builtin',
    chromePath: '/example/chrome',
    identity: { name: 'Gemma 4', raw: 'Gemma 4' },
    model: 'gemma4',
    profile: '/example/odai/gemma4',
  })
  expect(createBackend).toHaveBeenCalledWith(
    expect.objectContaining({ allowDownload: true, model: 'gemma4' }),
  )
  expect(destroy).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})

it('rejects an unavailable backend and a mismatched model while still closing', async () => {
  const unavailableClose = vi.fn().mockResolvedValue(undefined)
  await expect(
    setupChromeBuiltin(
      { chromePath: '/example/chrome', env: {} },
      {
        createBackend: () => ({
          availability: async () => ({
            available: false,
            reason: 'component service unavailable',
          }),
          close: unavailableClose,
          languageModel: vi.fn(),
          name: 'chrome-builtin',
        }),
        resolveConfig: async () => resolvedConfig('geminiNano'),
      },
    ),
  ).rejects.toThrow(/component service unavailable/u)
  expect(unavailableClose).toHaveBeenCalledOnce()

  const destroy = vi.fn()
  const close = vi.fn().mockResolvedValue(undefined)
  await expect(
    setupChromeBuiltin(
      { chromePath: '/example/chrome', env: {}, model: 'gemma4' },
      {
        createBackend: () => ({
          availability: async () => ({ available: true }),
          close,
          languageModel: async () => ({
            availability: async () => 'available',
            create: async () => ({
              destroy,
              prompt: async () => 'Gemini Nano',
              promptStreaming: async function* () {},
            }),
          }),
          name: 'chrome-builtin',
        }),
        resolveConfig: async () => resolvedConfig('gemma4'),
      },
    ),
  ).rejects.toThrow(/wanted Gemma 4/u)
  expect(destroy).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})
