import { expect, it, vi } from 'vitest'

import { modelLane, reportLanes } from '../../../scripts/setup-e2e.mts'

const config = {
  allowDownload: false,
  chromePath: '/example/chrome',
  chromePathCandidates: ['/example/chrome'],
  model: 'gemma4' as const,
  systemChromeUserDataDir: '/example/system',
  userDataDir: '/example/profile',
}

it('uses the public setup contract without changing the parent environment', async () => {
  const before = process.env['ODAI_CHROME_ALLOW_DOWNLOAD']
  const setup = vi.fn().mockResolvedValue({
    identity: { name: 'Gemma 4', raw: 'Gemma 4' },
    profile: config.userDataDir,
  })
  const result = await modelLane(
    { check: false },
    {
      resolveConfig: async () => config,
      setup,
    },
  )
  expect(result.ready).toBe(true)
  expect(setup).toHaveBeenCalledWith(
    expect.objectContaining({
      model: config.model,
      userDataDir: config.userDataDir,
      reclaimStorage: expect.any(Function),
    }),
  )
  expect(process.env['ODAI_CHROME_ALLOW_DOWNLOAD']).toBe(before)
})

it('reports missing weights without starting setup during a readiness check', async () => {
  const setup = vi.fn()
  const result = await modelLane(
    { check: true },
    {
      resolveConfig: async () => config,
      findSource: async () => ({ kind: 'download' }),
      setup,
    },
  )
  expect(result.ready).toBe(false)
  expect(setup).not.toHaveBeenCalled()
})

it('propagates provisioning failure instead of claiming readiness', async () => {
  const error = new Error('provisioning failed')
  await expect(
    modelLane(
      { check: false },
      {
        resolveConfig: async () => config,
        setup: async () => {
          throw error
        },
      },
    ),
  ).rejects.toBe(error)
})

it('returns failure when any requested prerequisite is missing', () => {
  const missing = [
    { detail: 'not installed', lane: 'model' as const, ready: false },
  ]
  const ready = [{ detail: 'installed', lane: 'model' as const, ready: true }]
  expect(reportLanes(missing)).toBe(1)
  expect(reportLanes(ready)).toBe(0)
})
