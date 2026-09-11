import fs from 'node:fs/promises'
import os from 'node:os'
import { expect, test, vi } from 'vitest'
import {
  browserFixture,
  getBrowserMocks,
  probeOptions,
} from './browser/util.mts'
import {
  assertGemmaIdentity,
  assertOfflineNetwork,
  assertProvisionCapacity,
  GemmaProbeError,
  probeGemmaBrowser,
} from '../../../../scripts/repo/cache/browser.mts'

const mocks = getBrowserMocks()

test('requires an unambiguous Gemma 4 response', () => {
  expect(() => assertGemmaIdentity('Gemma 4')).not.toThrow()
  for (const identity of [
    'Gemini Nano',
    'Gemma 3',
    '',
    'Gemma 4 or Gemini Nano',
  ]) {
    expect(() => assertGemmaIdentity(identity)).toThrow()
  }
})

test('accepts an isolated loopback namespace and rejects outward interfaces', () => {
  const loopback = {
    address: '127.0.0.1',
    cidr: '127.0.0.1/8',
    family: 'IPv4' as const,
    internal: true,
    mac: '00:00:00:00:00:00',
    netmask: '255.0.0.0',
  }
  expect(() =>
    assertOfflineNetwork({ interfaces: { lo: [loopback] } }),
  ).not.toThrow()
  expect(() =>
    assertOfflineNetwork({
      interfaces: {
        eth0: [{ ...loopback, address: '192.0.2.1', internal: false }],
      },
    }),
  ).toThrow()
})

test('requires sandbox, compatible Chrome, retained selection and a real Gemma response', async () => {
  const { close } = browserFixture()
  const receipt = await probeGemmaBrowser(probeOptions)
  expect(receipt).toMatchObject({
    model: 'gemma4',
    response: 'Gemma 4',
    sandbox: true,
  })
  expect(mocks.launch).toHaveBeenCalledWith({
    cpuOverride: undefined,
    profileDir: probeOptions.profile,
    executablePath: probeOptions.browser,
    logFile: '/example/private/chrome.log',
    network: 'provision',
    timeoutMs: expect.any(Number),
  })
  expect(close).toHaveBeenCalledOnce()
})

test('closes Chrome after an unsupported version', async () => {
  const fixture = browserFixture()
  fixture.send
    .mockReset()
    .mockResolvedValueOnce({ product: 'Chrome/152.0.0.0' })
  await expect(probeGemmaBrowser(probeOptions)).rejects.toThrow()
  expect(fixture.close).toHaveBeenCalledOnce()
})

test('opts into CPU inference on a smaller runner and reports its actual capacity', async () => {
  browserFixture()
  vi.spyOn(os, 'availableParallelism').mockReturnValue(2)
  vi.spyOn(os, 'totalmem').mockReturnValue(8 * 1024 ** 3)
  const receipt = await probeGemmaBrowser({
    ...probeOptions,
    cpuOverride: true,
  })
  expect(receipt).toMatchObject({
    availableParallelism: 2,
    cpuOverride: true,
    totalMemoryBytes: 8 * 1024 ** 3,
    model: 'gemma4',
    sandbox: true,
  })
  expect(mocks.launch).toHaveBeenCalledWith(
    expect.objectContaining({ cpuOverride: true, network: 'provision' }),
  )
})

test('allows a diagnostic capacity comparison without changing Chrome CPU flags', async () => {
  browserFixture()
  vi.spyOn(os, 'availableParallelism').mockReturnValue(2)
  vi.spyOn(os, 'totalmem').mockReturnValue(8 * 1024 ** 3)
  const receipt = await probeGemmaBrowser({
    ...probeOptions,
    allowInsufficientCapacity: true,
  })
  expect(receipt).toMatchObject({
    allowInsufficientCapacity: true,
    cpuOverride: false,
    diagnostics: {
      machine: { availableParallelism: 2, totalMemoryBytes: 8 * 1024 ** 3 },
    },
  })
  expect(mocks.launch).toHaveBeenCalledWith(
    expect.objectContaining({ cpuOverride: undefined }),
  )
})

test('captures diagnostics before successful shutdown and retains the first availability', async () => {
  const fixture = browserFixture()
  const receipt = await probeGemmaBrowser(probeOptions)
  expect(receipt.diagnostics).toMatchObject({
    availability: 'available',
    firstAvailability: 'available',
    browser: {
      broker: {
        status: 'captured',
        data: { models: [{ backendType: 'CPU' }] },
      },
    },
  })
  expect(fixture.brokerClose.mock.invocationCallOrder.at(-1)).toBeLessThan(
    fixture.close.mock.invocationCallOrder[0]!,
  )
})

test('retains the disk requirement when CPU inference is explicitly requested', async () => {
  browserFixture()
  mocks.launch.mockClear()
  vi.spyOn(fs, 'statfs').mockResolvedValue({
    bavail: 18 * 1024 ** 3,
    bfree: 18 * 1024 ** 3,
    blocks: 60 * 1024 ** 3,
    bsize: 1,
    frsize: 1,
    ffree: 100,
    files: 100,
    type: 1,
  })
  await expect(
    probeGemmaBrowser({ ...probeOptions, cpuOverride: true }),
  ).rejects.toThrow()
  expect(mocks.launch).not.toHaveBeenCalled()
})

test('preserves the CPU option during isolated offline verification', async () => {
  browserFixture()
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({})
  expect(
    await probeGemmaBrowser({
      ...probeOptions,
      cpuOverride: true,
      offline: true,
    }),
  ).toMatchObject({ cpuOverride: true, offline: true, sandbox: true })
  expect(mocks.launch).toHaveBeenCalledWith(
    expect.objectContaining({ cpuOverride: true, network: 'offline' }),
  )
})

test.each(['--no-sandbox', '--disable-setuid-sandbox'])(
  'rejects the runtime sandbox bypass %s and closes Chrome',
  async argument => {
    const fixture = browserFixture()
    fixture.send
      .mockReset()
      .mockResolvedValueOnce({ product: 'Chrome/154.0.0.0' })
      .mockResolvedValueOnce({ arguments: [argument] })
    await expect(probeGemmaBrowser(probeOptions)).rejects.toThrow()
    expect(fixture.close).toHaveBeenCalledOnce()
  },
)

test('does not accept a missing API or discarded Gemma flag', async () => {
  const fixture = browserFixture()
  fixture.evaluate.mockReset().mockResolvedValueOnce('missing-api')
  await expect(probeGemmaBrowser(probeOptions)).rejects.toThrow()
  browserFixture()
  vi.mocked(fs.readFile).mockResolvedValue('{}')
  await expect(probeGemmaBrowser(probeOptions)).rejects.toThrow()
})

test('closes a browser that launches after the deadline', async () => {
  vi.useFakeTimers()
  const fixture = browserFixture()
  mocks.launch.mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, 2000))
    return { context: { close: fixture.close } }
  })
  const result = expect(
    probeGemmaBrowser({ ...probeOptions, timeoutMs: 1000 }),
  ).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(2000)
  await result
  expect(fixture.close).toHaveBeenCalledOnce()
})

test('does not start Chrome after diagnostic setup exhausts the deadline', async () => {
  vi.useFakeTimers()
  browserFixture()
  mocks.nativeCreate.mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, 2000))
    return { read: mocks.nativeRead, close: mocks.nativeClose }
  })
  const result = expect(
    probeGemmaBrowser({ ...probeOptions, timeoutMs: 1000 }),
  ).rejects.toBeInstanceOf(GemmaProbeError)
  await vi.advanceTimersByTimeAsync(2000)
  await result
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.nativeClose).toHaveBeenCalledOnce()
})

test('surfaces activation rejection and closes Chrome before the deadline', async () => {
  const fixture = browserFixture()
  const failure = new DOMException('Model download failed', 'NetworkError')
  const create = vi.fn().mockRejectedValue(failure)
  vi.stubGlobal('LanguageModel', {
    availability: vi.fn().mockResolvedValue('downloadable'),
    create,
  })
  fixture.evaluate.mockReset().mockImplementation(callback => callback())
  await expect(
    probeGemmaBrowser({ ...probeOptions, timeoutMs: 100 }),
  ).rejects.toMatchObject({
    name: 'GemmaProbeError',
    cause: failure,
    diagnostics: {
      firstAvailability: 'downloadable',
      availability: 'downloadable',
      browser: { broker: { status: 'captured' } },
    },
  })
  expect(create).toHaveBeenCalledOnce()
  expect(fixture.close).toHaveBeenCalledOnce()
  expect(mocks.nativeRead.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
    fixture.close.mock.invocationCallOrder.at(-1)!,
  )
  expect(mocks.nativeClose).toHaveBeenCalledOnce()
})

test('retains the last availability when activation exceeds the deadline', async () => {
  const fixture = browserFixture()
  const activation = Promise.withResolvers<never>()
  vi.stubGlobal('LanguageModel', {
    availability: vi.fn().mockResolvedValue('downloading'),
    create: vi.fn().mockReturnValue(activation.promise),
  })
  fixture.evaluate.mockReset().mockImplementation(callback => callback())
  fixture.close.mockImplementation(async () => {
    activation.reject(new Error('Browser context closed'))
  })
  await expect(
    probeGemmaBrowser({ ...probeOptions, timeoutMs: 20 }),
  ).rejects.toMatchObject({
    cause: { cause: { availability: 'downloading' } },
    diagnostics: {
      firstAvailability: 'downloading',
      browser: { broker: { status: 'captured' } },
    },
  })
})

test('retains browser diagnostics when the first availability call hangs', async () => {
  vi.useFakeTimers()
  const fixture = browserFixture()
  const availability = Promise.withResolvers<never>()
  fixture.evaluate.mockReset().mockReturnValue(availability.promise)
  fixture.close.mockImplementation(async () => {
    availability.reject(new Error('Browser context closed'))
  })
  const result = expect(
    probeGemmaBrowser({ ...probeOptions, timeoutMs: 1000 }),
  ).rejects.toMatchObject({
    diagnostics: {
      firstAvailability: 'not-checked',
      availability: 'not-checked',
      browser: {
        broker: {
          status: 'captured',
          data: { models: [{ backendType: 'CPU' }] },
        },
        histograms: { status: 'captured', data: [] },
      },
    },
  })
  const outcomes = await Promise.allSettled([
    result,
    vi.advanceTimersByTimeAsync(1000),
  ])
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      throw outcome.reason
    }
  }
  expect(fixture.brokerClose.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.evaluate.mock.invocationCallOrder[0]!,
  )
})

test('preserves the inference failure when diagnostic collection also fails', async () => {
  const fixture = browserFixture()
  const failure = new DOMException('Session unavailable', 'InvalidStateError')
  fixture.evaluate
    .mockReset()
    .mockResolvedValueOnce('available')
    .mockRejectedValueOnce(failure)
  fixture.brokerEvaluate.mockRejectedValue(new Error('private-value'))
  const result = probeGemmaBrowser(probeOptions)
  await expect(result).rejects.toBeInstanceOf(GemmaProbeError)
  await expect(result).rejects.toMatchObject({
    cause: failure,
    diagnostics: { browser: { broker: { status: 'unavailable' } } },
  })
  expect(fixture.close).toHaveBeenCalledOnce()
})

test('destroys the activation session before verifying model identity', async () => {
  vi.useFakeTimers()
  const fixture = browserFixture()
  const destroy = vi.fn()
  const prompt = vi.fn().mockResolvedValue('Gemma 4')
  const create = vi.fn().mockResolvedValue({ destroy, prompt })
  vi.stubGlobal('LanguageModel', {
    availability: vi
      .fn()
      .mockResolvedValueOnce('downloadable')
      .mockResolvedValue('available'),
    create,
  })
  fixture.evaluate.mockReset().mockImplementation(callback => callback())
  const result = probeGemmaBrowser(probeOptions)
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result).toMatchObject({
    model: 'gemma4',
  })
  expect(create).toHaveBeenCalledTimes(2)
  expect(destroy).toHaveBeenCalledTimes(2)
  expect(prompt).toHaveBeenCalledOnce()
  expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(
    prompt.mock.invocationCallOrder[0]!,
  )
})

test('waits for copied components to register without starting an offline download', async () => {
  vi.useFakeTimers()
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({})
  const fixture = browserFixture()
  fixture.evaluate
    .mockReset()
    .mockResolvedValueOnce('downloadable')
    .mockResolvedValueOnce('available')
    .mockResolvedValueOnce('Gemma 4')
  const result = probeGemmaBrowser({ ...probeOptions, offline: true })
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result).toMatchObject({ offline: true, model: 'gemma4' })
  expect(fixture.evaluate).toHaveBeenCalledTimes(3)
})

test('rejects insufficient disk, CPU and memory before launching Chrome', async () => {
  const capacity = {
    availableParallelism: 4,
    freeDiskBytes: 22 * 1024 ** 3,
    platform: 'linux',
    totalMemoryBytes: 15_000 * 1024 ** 2,
  }
  expect(() =>
    assertProvisionCapacity('/example/profile', capacity),
  ).not.toThrow()
  expect(() =>
    assertProvisionCapacity('/example/profile', {
      ...capacity,
      platform: 'darwin',
      availableParallelism: 2,
      totalMemoryBytes: 8 * 1024 ** 3,
    }),
  ).not.toThrow()
  for (const config of [
    { ...capacity, freeDiskBytes: 18 * 1024 ** 3 },
    { ...capacity, availableParallelism: 2 },
    { ...capacity, totalMemoryBytes: 8 * 1024 ** 3 },
  ]) {
    expect(() => assertProvisionCapacity('/example/profile', config)).toThrow()
  }
  browserFixture()
  mocks.launch.mockClear()
  vi.spyOn(os, 'totalmem').mockReturnValue(8 * 1024 ** 3)
  await expect(probeGemmaBrowser(probeOptions)).rejects.toThrow()
  expect(mocks.launch).not.toHaveBeenCalled()
})
