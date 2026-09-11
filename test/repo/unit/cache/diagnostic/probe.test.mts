import { beforeEach, expect, test, vi } from 'vitest'
import { probeGemmaWithDiagnostics } from '../../../../../scripts/repo/cache/diagnostic/probe.mts'

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  mkdir: vi.fn(),
  probe: vi.fn(),
  write: vi.fn(),
}))

vi.mock(import('node:fs/promises'), async original => ({
  ...(await original()),
  default: { ...(await original()).default, mkdir: mocks.mkdir },
}))
vi.mock(
  import('../../../../../scripts/repo/cache/browser.mts'),
  async original => ({
    ...(await original()),
    probeGemmaBrowser: mocks.probe,
  }),
)
vi.mock(import('../../../../../scripts/repo/cache/crash/collect.mts'), () => ({
  collectGemmaCrashReports: mocks.collect,
}))
vi.mock(
  import('../../../../../scripts/repo/cache/diagnostic/context.mts'),
  () => ({ writeGemmaDiagnosticContext: mocks.write }),
)

const config = {
  bridge: '/profile/odai-cache.html',
  browser: '/usr/bin/google-chrome-beta',
  cpuOverride: true,
  diagnosticRoot: '/private',
  imageDigest: `sha256:${'1'.repeat(64)}`,
  offline: true,
  profile: '/profile',
  timeoutMs: 60_000,
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.probe.mockResolvedValue({ model: 'gemma4', response: 'Gemma 4' })
  mocks.collect.mockResolvedValue({ status: 'captured', reports: [] })
})

test('retains native evidence and writes launch context after successful inference', async () => {
  await expect(probeGemmaWithDiagnostics(config)).resolves.toMatchObject({
    model: 'gemma4',
  })
  expect(mocks.probe).toHaveBeenCalledWith(
    expect.objectContaining({
      diagnosticRoot: '/private/native',
      preserveDiagnostics: true,
    }),
  )
  expect(mocks.collect).toHaveBeenCalledWith('/private/crashes', {
    preserveReports: true,
  })
  expect(mocks.write).toHaveBeenCalledWith(
    expect.objectContaining({
      imageDigest: config.imageDigest,
      result: expect.objectContaining({
        launch: {
          browser: config.browser,
          cpuOverride: true,
          offline: true,
          timeoutMs: 60_000,
        },
      }),
    }),
  )
})

test('captures context on failure and preserves the original error', async () => {
  const failure = new Error('Fixture failure with private diagnostic detail')
  mocks.probe.mockRejectedValue(failure)
  await expect(probeGemmaWithDiagnostics(config)).rejects.toBe(failure)
  expect(mocks.write).toHaveBeenCalledWith(
    expect.objectContaining({
      result: expect.objectContaining({ failure: { name: 'Error' } }),
    }),
  )
})

test('does not replace an inference failure when context storage fails', async () => {
  const failure = new Error('Inference failed')
  mocks.probe.mockRejectedValue(failure)
  mocks.write.mockRejectedValue(new Error('Disk unavailable'))
  const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    await expect(probeGemmaWithDiagnostics(config)).rejects.toBe(failure)
    expect(output).toHaveBeenCalledOnce()
  } finally {
    output.mockRestore()
  }
})

test('fails a successful probe when requested evidence could not be retained', async () => {
  const failure = new Error('Disk unavailable')
  mocks.write.mockRejectedValue(failure)
  await expect(probeGemmaWithDiagnostics(config)).rejects.toBe(failure)
})

test('rejects a relative diagnostic path before launching the browser', async () => {
  await expect(
    probeGemmaWithDiagnostics({ ...config, diagnosticRoot: 'relative' }),
  ).rejects.toThrow()
  expect(mocks.probe).not.toHaveBeenCalled()
})
