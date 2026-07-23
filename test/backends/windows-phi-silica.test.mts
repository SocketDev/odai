import { describe, expect, it } from 'vitest'

import { createWindowsPhiSilicaBackend } from '../../src/backends/windows-phi-silica.mts'

describe('windows-phi-silica backend', () => {
  it('names the host platform in the reason off-Windows', async () => {
    const backend = createWindowsPhiSilicaBackend({ platform: 'darwin' })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('Phi Silica (Copilot+)')
    expect(availability.reason).toContain('darwin')
  })

  it('reports the Copilot+ NPU requirement on Windows hosts', async () => {
    const backend = createWindowsPhiSilicaBackend({ platform: 'win32' })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('Copilot+ NPU')
    expect(availability.reason).toContain('hosted CI VMs are ineligible')
  })

  it('refuses to hand out a session factory with the declared reason', async () => {
    const backend = createWindowsPhiSilicaBackend({ platform: 'win32' })
    await expect(backend.languageModel()).rejects.toThrow(
      /Phi Silica \(Copilot\+\).*Copilot\+ NPU/s,
    )
  })
})
