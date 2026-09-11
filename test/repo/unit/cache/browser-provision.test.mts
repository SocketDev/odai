import fs from 'node:fs/promises'
import os from 'node:os'
import { expect, test, vi } from 'vitest'
import {
  browserFixture,
  getBrowserMocks,
  probeOptions,
} from './browser/util.mts'
import { probeGemmaProvision } from '../../../../scripts/repo/cache/browser.mts'

const mocks = getBrowserMocks()

test('preserves the first failure when retry preflight rejects', async () => {
  const fixture = browserFixture()
  fixture.evaluate.mockReset().mockImplementation(async () => {
    vi.mocked(fs.statfs).mockRejectedValueOnce(
      new Error('Profile is unavailable'),
    )
    throw new DOMException('Session unavailable', 'InvalidStateError')
  })
  await expect(
    probeGemmaProvision({ ...probeOptions, cpuOverride: true }),
  ).rejects.toMatchObject({
    name: 'GemmaProvisionError',
    diagnostics: [
      expect.objectContaining({ cpuOverride: true }),
      { status: 'unavailable' },
    ],
    errors: [expect.any(Error), expect.any(Error)],
  })
  expect(mocks.launch).toHaveBeenCalledOnce()
})

test('retries CPU provisioning on its retained profile within the original deadline', async () => {
  vi.useFakeTimers()
  const fixture = browserFixture()
  fixture.evaluate
    .mockReset()
    .mockResolvedValueOnce('downloading')
    .mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 20_000)
      throw new DOMException('Session unavailable', 'InvalidStateError')
    })
    .mockResolvedValueOnce('available')
    .mockResolvedValueOnce('Gemma 4')
  fixture.send.mockImplementation(async (method: string) => {
    if (method === 'Browser.getVersion') {
      return { product: 'Chrome/154.0.8037.0' }
    }
    if (method === 'Browser.getBrowserCommandLine') {
      return { arguments: ['--enable-automation'] }
    }
    return { histograms: [] }
  })
  const receipt = await probeGemmaProvision({
    ...probeOptions,
    cpuOverride: true,
  })
  expect(receipt.previousAttempts).toHaveLength(1)
  expect(mocks.launch).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      profileDir: probeOptions.profile,
      timeoutMs: 40_000,
    }),
  )
  expect(fixture.close).toHaveBeenCalledTimes(2)
})

test('preserves both failed retained-profile attempts', async () => {
  const fixture = browserFixture()
  fixture.evaluate
    .mockReset()
    .mockRejectedValue(
      new DOMException('Session unavailable', 'InvalidStateError'),
    )
  await expect(
    probeGemmaProvision({ ...probeOptions, cpuOverride: true }),
  ).rejects.toMatchObject({
    name: 'GemmaProvisionError',
    diagnostics: [
      expect.objectContaining({ cpuOverride: true }),
      expect.objectContaining({ cpuOverride: true }),
    ],
  })
  expect(mocks.launch).toHaveBeenCalledTimes(2)
})

test('does not extend an exhausted provisioning budget', async () => {
  vi.useFakeTimers()
  const fixture = browserFixture()
  fixture.evaluate.mockReset().mockImplementation(async () => {
    vi.setSystemTime(Date.now() + probeOptions.timeoutMs)
    throw new DOMException('Session unavailable', 'InvalidStateError')
  })
  await expect(
    probeGemmaProvision({ ...probeOptions, cpuOverride: true }),
  ).rejects.toMatchObject({
    name: 'GemmaProvisionError',
    diagnostics: [expect.objectContaining({ cpuOverride: true })],
  })
  expect(mocks.launch).toHaveBeenCalledOnce()
})

test.each([false, true])(
  'never retries default or offline probes: offline=%s',
  async offline => {
    const fixture = browserFixture()
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({})
    fixture.evaluate.mockReset().mockRejectedValue(new Error('Unavailable'))
    await expect(
      probeGemmaProvision({ ...probeOptions, offline, cpuOverride: offline }),
    ).rejects.toMatchObject({
      name: 'GemmaProvisionError',
      diagnostics: [expect.objectContaining({ cpuOverride: offline })],
    })
    expect(mocks.launch).toHaveBeenCalledOnce()
  },
)
