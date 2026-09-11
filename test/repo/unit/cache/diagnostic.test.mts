import fs from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { afterEach, expect, test, vi } from 'vitest'
import { collectGemmaDiagnostics } from '../../../../scripts/repo/cache/diagnostic.mts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function diagnosticFixture() {
  const broker = { models: [{ backendType: 'CPU' }], useCases: [] }
  const close = vi.fn().mockResolvedValue(undefined)
  const evaluate = vi.fn().mockResolvedValue(broker)
  const click = vi.fn().mockResolvedValue(undefined)
  const waitFor = vi.fn().mockResolvedValue(undefined)
  const diagnosticPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('chrome://on-device-internals/'),
    getByRole: vi.fn().mockReturnValue({ click }),
    locator: vi.fn().mockReturnValue({ evaluate, waitFor }),
    evaluate,
    close,
  }
  const send = vi.fn().mockResolvedValue({ histograms: [] })
  const detach = vi.fn().mockResolvedValue(undefined)
  const newPage = vi.fn().mockResolvedValue(diagnosticPage)
  const newCDPSession = vi.fn().mockResolvedValue({ send, detach })
  const launch = vi.spyOn(chromium, 'launchPersistentContext')
  vi.mocked(launch, { partial: true }).mockResolvedValue({
    newPage,
    newCDPSession,
  })
  const context = await launch('/example/profile')
  const page = await context.newPage()
  newPage.mockClear()
  vi.spyOn(fs, 'readFile').mockResolvedValue('{}')
  return {
    context,
    diagnosticPage,
    click,
    evaluate,
    newPage,
    newCDPSession,
    send,
    detach,
    close,
    page,
  }
}

test('collects broker state and histograms and closes only the diagnostic page', async () => {
  const fixture = await diagnosticFixture()
  const result = await collectGemmaDiagnostics({
    ...fixture,
    profile: '/example/profile',
    timeoutMs: 1000,
  })
  expect(result.broker).toMatchObject({
    status: 'captured',
    data: { models: [{ backendType: 'CPU' }] },
  })
  expect(result.histograms).toEqual({ status: 'captured', data: [] })
  expect(fixture.send).toHaveBeenCalledWith('Browser.getHistograms', {
    query: 'OnDeviceModel',
    delta: false,
  })
  expect(fixture.send).toHaveBeenCalledWith('Browser.getHistograms', {
    query: 'ChildProcess',
    delta: false,
  })
  expect(fixture.close).toHaveBeenCalledOnce()
  expect(fixture.detach).toHaveBeenCalledOnce()
  expect(fixture.diagnosticPage.getByRole).not.toHaveBeenCalled()
})

test('enables disabled debug pages through the supported Chrome control', async () => {
  const fixture = await diagnosticFixture()
  fixture.diagnosticPage.url.mockReturnValueOnce(
    'chrome://debug-webuis-disabled/?host=chrome://on-device-internals/',
  )
  const result = await collectGemmaDiagnostics({
    ...fixture,
    profile: '/example/profile',
    timeoutMs: 1000,
  })
  expect(result.broker.status).toBe('captured')
  expect(fixture.diagnosticPage.goto.mock.calls.map(call => call[0])).toEqual([
    'chrome://on-device-internals/',
    'chrome://chrome-urls/',
    'chrome://on-device-internals/',
  ])
  expect(fixture.diagnosticPage.getByRole).toHaveBeenCalledWith('button', {
    name: 'Enable internal debugging pages',
    exact: true,
  })
  expect(fixture.click).toHaveBeenCalledOnce()
  expect(fixture.close).toHaveBeenCalledOnce()
})

test('reports unavailable when policy prevents enabling diagnostic pages', async () => {
  const fixture = await diagnosticFixture()
  fixture.diagnosticPage.url.mockReturnValue(
    'chrome://debug-webuis-disabled/?host=chrome://on-device-internals/',
  )
  fixture.click.mockRejectedValue(new Error('private-value'))
  const result = await collectGemmaDiagnostics({
    ...fixture,
    profile: '/example/profile',
    timeoutMs: 1000,
  })
  expect(result.broker).toEqual({ status: 'unavailable' })
  expect(fixture.evaluate).not.toHaveBeenCalled()
  expect(fixture.close).toHaveBeenCalledOnce()
})

test('rejects a remaining diagnostic redirect without reading another page', async () => {
  const fixture = await diagnosticFixture()
  fixture.diagnosticPage.url.mockReturnValue('chrome://chrome-urls/')
  const result = await collectGemmaDiagnostics({
    ...fixture,
    profile: '/example/profile',
    timeoutMs: 1000,
  })
  expect(result.broker).toEqual({ status: 'unavailable' })
  expect(fixture.evaluate).not.toHaveBeenCalled()
  expect(fixture.click).not.toHaveBeenCalled()
})

test('refreshes the existing broker before reading its state', async () => {
  const fixture = await diagnosticFixture()
  const component = {
    state_: { models: [] as Array<{ backendType: string }> },
    getBrokerState_: vi.fn().mockImplementation(async () => {
      component.state_ = { models: [{ backendType: 'CPU' }] }
    }),
  }
  fixture.evaluate.mockImplementation(
    (callback: (element: unknown) => Promise<unknown>) => callback(component),
  )
  const result = await collectGemmaDiagnostics({
    ...fixture,
    profile: '/example/profile',
    timeoutMs: 1000,
  })
  expect(result.broker).toMatchObject({
    status: 'captured',
    data: { models: [{ backendType: 'CPU' }] },
  })
  expect(component.getBrokerState_).toHaveBeenCalledOnce()
})

test('preserves broker disconnection instead of reporting its empty initial state', async () => {
  const fixture = await diagnosticFixture()
  const component = {
    state_: { models: [] },
    getBrokerState_: vi.fn().mockRejectedValue(new Error('private-value')),
  }
  fixture.evaluate.mockImplementation(
    (callback: (element: unknown) => Promise<unknown>) => callback(component),
  )
  const result = await collectGemmaDiagnostics({
    ...fixture,
    profile: '/example/profile',
    timeoutMs: 1000,
  })
  expect(result.broker).toEqual({ status: 'unavailable' })
  expect(component.getBrokerState_).toHaveBeenCalledOnce()
})

test('keeps completed channels when another diagnostic channel hangs', async () => {
  vi.useFakeTimers()
  const fixture = await diagnosticFixture()
  const pending = Promise.withResolvers<unknown>()
  fixture.evaluate.mockReturnValue(pending.promise)
  const result = collectGemmaDiagnostics({
    ...fixture,
    profile: '/example/profile',
    timeoutMs: 25,
  })
  await vi.advanceTimersByTimeAsync(25)
  expect(await result).toMatchObject({
    broker: { status: 'timed-out' },
    histograms: { status: 'captured', data: [] },
  })
  pending.resolve({ models: [] })
})

test('caps diagnostic startup at ten seconds within the original deadline', async () => {
  vi.useFakeTimers()
  const fixture = await diagnosticFixture()
  const pending = Promise.withResolvers<unknown>()
  fixture.evaluate.mockReturnValue(pending.promise)
  const completed = vi.fn()
  const result = collectGemmaDiagnostics({
    ...fixture,
    profile: '/example/profile',
    timeoutMs: 60_000,
  }).then(value => {
    completed()
    return value
  })
  await vi.advanceTimersByTimeAsync(9999)
  expect(completed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(await result).toMatchObject({ broker: { status: 'timed-out' } })
  expect(completed).toHaveBeenCalledOnce()
  pending.resolve({ models: [] })
})

test('diagnostic failures never copy rejection text or escape into the probe', async () => {
  const fixture = await diagnosticFixture()
  fixture.evaluate.mockRejectedValue(new Error('private-value'))
  fixture.send.mockRejectedValue(new Error('private-value'))
  vi.mocked(fs.readFile).mockRejectedValue(new Error('private-value'))
  expect(
    await collectGemmaDiagnostics({
      ...fixture,
      profile: '/example/profile',
      timeoutMs: 1000,
    }),
  ).toEqual({
    broker: { status: 'unavailable' },
    histograms: { status: 'unavailable' },
    preferences: { status: 'unavailable' },
  })
})

test('does not start diagnostics when the original probe budget is exhausted', async () => {
  const fixture = await diagnosticFixture()
  expect(
    await collectGemmaDiagnostics({
      ...fixture,
      profile: '/example/profile',
      timeoutMs: 0,
    }),
  ).toMatchObject({ broker: { status: 'timed-out' } })
  expect(fixture.newPage).not.toHaveBeenCalled()
  expect(fixture.newCDPSession).not.toHaveBeenCalled()
})
