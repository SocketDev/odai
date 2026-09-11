import fs from 'node:fs/promises'
import path from 'node:path'
import { GemmaProbeError, probeGemmaBrowser } from '../browser.mts'
import { collectGemmaCrashReports } from '../crash/collect.mts'
import { writeGemmaDiagnosticContext } from './context.mts'
import type { BrowserProbeConfig } from '../browser.mts'

export async function probeGemmaWithDiagnostics(
  config: BrowserProbeConfig & { imageDigest: string },
) {
  const options = { ...config }
  const directory = options.diagnosticRoot
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error(
      'Gemma diagnostics require an absolute output directory. Supply --diagnostics with a new private directory.',
    )
  }
  await fs.mkdir(path.join(directory, 'native'), { mode: 0o700 })
  await fs.mkdir(path.join(directory, 'crashes'), { mode: 0o700 })
  let receipt: Awaited<ReturnType<typeof probeGemmaBrowser>> | undefined
  let failure: unknown
  let originalFailure: unknown
  let failed = false
  try {
    receipt = await probeGemmaBrowser({
      ...options,
      diagnosticRoot: path.join(directory, 'native'),
      preserveDiagnostics: true,
    })
  } catch (error) {
    failed = true
    originalFailure = error
    failure =
      error instanceof GemmaProbeError
        ? { name: error.name, diagnostics: error.diagnostics }
        : { name: error instanceof Error ? error.name : 'UnknownError' }
  }
  try {
    const crashReports = await collectGemmaCrashReports(
      path.join(directory, 'crashes'),
      { preserveReports: true },
    )
    await writeGemmaDiagnosticContext({
      directory,
      imageDigest: options.imageDigest,
      sourceRun: 'local',
      result: {
        receipt,
        failure,
        crashReports,
        launch: {
          browser: options.browser,
          cpuOverride: options.cpuOverride === true,
          offline: options.offline,
          timeoutMs: options.timeoutMs,
        },
      },
    })
  } catch (error) {
    if (!failed) {
      throw error
    }
    process.stderr.write(
      'Gemma diagnostic context is incomplete. Retained native logs and crash reports remain in the diagnostics directory.\n',
    )
  }
  if (failed) {
    throw originalFailure
  }
  return receipt!
}
