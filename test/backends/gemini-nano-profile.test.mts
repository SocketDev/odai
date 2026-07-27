import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildLocalStateSeed,
  chromeMissingReason,
  chromeNowMicros,
  chromePathCandidates,
  cloneDir,
  defaultBridgeUserDataDir,
  ensureBridgeProfile,
  envFlag,
  findModelSource,
  isNodeRuntime,
  MODEL_COMPONENT_DIR,
  ODAI_CHROME_ENV_VAR,
  ODAI_NANO_ALLOW_DOWNLOAD_ENV_VAR,
  ODAI_NANO_USER_DATA_DIR_ENV_VAR,
  pathToFileUrl,
  readSystemLocalState,
  resolveBridgeConfig,
  systemChromeUserDataDirFor,
} from '../../src/backends/gemini-nano-profile.mts'
import type { ResolvedBridgeConfig } from '../../src/backends/gemini-nano-profile.mts'

async function tmpDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'odai-profile-test-'))
}

describe('chromePathCandidates', () => {
  it('lists the two macOS Chrome locations', () => {
    const candidates = chromePathCandidates('darwin', {}, '/Users/x')
    expect(candidates[0]).toContain('/Applications/Google Chrome.app')
    expect(candidates[1]).toContain('/Users/x/Applications/Google Chrome.app')
  })

  it('builds Windows candidates from the env base dirs', () => {
    const candidates = chromePathCandidates(
      'win32',
      { LOCALAPPDATA: 'C:\\Local', PROGRAMFILES: 'C:\\PF' },
      'C:\\Users\\x',
    )
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toBe(
      'C:\\Local\\Google\\Chrome\\Application\\chrome.exe',
    )
  })

  it('lists the well-known Linux paths', () => {
    const candidates = chromePathCandidates('linux', {}, '/home/x')
    expect(candidates).toContain('/usr/bin/google-chrome')
    expect(candidates).toContain('/opt/google/chrome/chrome')
  })
})

describe('systemChromeUserDataDirFor', () => {
  it('resolves the macOS profile dir', () => {
    expect(systemChromeUserDataDirFor('darwin', {}, '/Users/x')).toContain(
      '/Users/x/Library/Application Support/Google/Chrome',
    )
  })

  it('resolves the Windows profile dir from LOCALAPPDATA', () => {
    expect(
      systemChromeUserDataDirFor(
        'win32',
        { LOCALAPPDATA: 'C:\\Local' },
        'C:\\x',
      ),
    ).toBe('C:\\Local\\Google\\Chrome\\User Data')
  })

  it('honors XDG_CONFIG_HOME on Linux', () => {
    expect(
      systemChromeUserDataDirFor(
        'linux',
        { XDG_CONFIG_HOME: '/cfg' },
        '/home/x',
      ),
    ).toBe('/cfg/google-chrome')
  })

  it('falls back to ~/.config on Linux without XDG_CONFIG_HOME', () => {
    expect(systemChromeUserDataDirFor('linux', {}, '/home/x')).toBe(
      '/home/x/.config/google-chrome',
    )
  })
})

describe('defaultBridgeUserDataDir', () => {
  it('uses XDG_CACHE_HOME when set', () => {
    expect(
      defaultBridgeUserDataDir({ XDG_CACHE_HOME: '/cache' }, '/home/x', path),
    ).toBe('/cache/odai/gemini-nano-headless')
  })

  it('falls back to the home cache dir without XDG_CACHE_HOME', () => {
    expect(defaultBridgeUserDataDir({}, '/home/x', path)).toBe(
      ['/home/x', '.cache', 'odai', 'gemini-nano-headless'].join('/'),
    )
  })
})

describe('envFlag', () => {
  it('is true only for the enabling tokens', () => {
    expect(envFlag('1')).toBe(true)
    expect(envFlag('true')).toBe(true)
    expect(envFlag('0')).toBe(false)
    expect(envFlag(undefined)).toBe(false)
  })
})

describe('pathToFileUrl', () => {
  it('encodes a POSIX path into a file url', () => {
    expect(pathToFileUrl('/tmp/a b.html')).toBe('file:///tmp/a%20b.html')
  })

  it('normalizes backslashes and adds a leading slash', () => {
    expect(pathToFileUrl('C:\\tmp\\page.html')).toBe('file:///C:/tmp/page.html')
  })
})

describe('chromeNowMicros', () => {
  it('returns a numeric microsecond string past the Windows epoch offset', () => {
    const micros = chromeNowMicros()
    expect(/^\d+$/.test(micros)).toBe(true)
    expect(Number(micros)).toBeGreaterThan(11_644_473_600_000 * 1000)
  })
})

describe('chromeMissingReason', () => {
  it('lists the probed candidates and the remedy env var', () => {
    const config = {
      chromePathCandidates: ['/a/chrome', '/b/chrome'],
    } as ResolvedBridgeConfig
    const reason = chromeMissingReason(config)
    expect(reason).toContain('/a/chrome, /b/chrome')
    expect(reason).toContain('ODAI_CHROME')
    expect(reason).toContain('Chromium builds do not work')
  })
})

describe('isNodeRuntime', () => {
  it('is true under the Node test runtime', () => {
    expect(isNodeRuntime()).toBe(true)
  })
})

describe('buildLocalStateSeed', () => {
  it('seeds labs experiments, feature usage, and updater data', () => {
    const seeded = buildLocalStateSeed(
      { existingKey: 'kept' },
      { onDevice: { perf: 6 }, updaterApp: { pv: '1.2.3' } },
    )
    expect(seeded['existingKey']).toBe('kept')
    const browser = seeded['browser'] as { enabled_labs_experiments: string[] }
    expect(browser.enabled_labs_experiments).toContain(
      'prompt-api-for-gemini-nano@1',
    )
    const guide = seeded['optimization_guide'] as {
      model_execution: { last_usage_by_feature: Record<string, string> }
      on_device: Record<string, unknown>
    }
    expect(guide.model_execution.last_usage_by_feature['6']).toBeDefined()
    expect(guide.on_device['perf']).toBe(6)
    const updater = seeded['updateclientdata'] as {
      apps: Record<string, unknown>
    }
    expect(updater.apps['fklghjjljmnfjoepjmlobpekiapffcja']).toEqual({
      pv: '1.2.3',
    })
  })

  it('omits updater data when the system carries none', () => {
    const seeded = buildLocalStateSeed(
      {},
      { onDevice: {}, updaterApp: undefined },
    )
    expect(seeded['updateclientdata']).toBeUndefined()
  })
})

describe('resolveBridgeConfig', () => {
  it('uses an explicit chromePath and detects it on disk', async () => {
    const root = await tmpDir()
    const chromePath = path.join(root, 'chrome')
    await writeFile(chromePath, '#!/bin/sh\n')
    const config = await resolveBridgeConfig({
      chromePath,
      env: {},
      systemChromeUserDataDir: path.join(root, 'sys'),
      userDataDir: path.join(root, 'profile'),
    })
    expect(config.chromePath).toBe(chromePath)
    expect(config.chromePathCandidates).toEqual([chromePath])
    expect(config.allowDownload).toBe(false)
  })

  it('reads chrome, download, and user-data settings from the env', async () => {
    const root = await tmpDir()
    const chromePath = path.join(root, 'chrome')
    await writeFile(chromePath, '#!/bin/sh\n')
    const config = await resolveBridgeConfig({
      env: {
        [ODAI_CHROME_ENV_VAR]: chromePath,
        [ODAI_NANO_ALLOW_DOWNLOAD_ENV_VAR]: '1',
        [ODAI_NANO_USER_DATA_DIR_ENV_VAR]: path.join(root, 'from-env'),
      },
    })
    expect(config.chromePath).toBe(chromePath)
    expect(config.allowDownload).toBe(true)
    expect(config.userDataDir).toBe(path.join(root, 'from-env'))
  })

  it('leaves chromePath undefined when no candidate exists', async () => {
    const root = await tmpDir()
    const config = await resolveBridgeConfig({
      chromePath: path.join(root, 'missing-chrome'),
      env: {},
    })
    expect(config.chromePath).toBeUndefined()
  })
})

describe('findModelSource', () => {
  it('picks the bridge profile when it already has the component', async () => {
    const root = await tmpDir()
    const userDataDir = path.join(root, 'profile')
    await mkdir(path.join(userDataDir, MODEL_COMPONENT_DIR), {
      recursive: true,
    })
    const source = await findModelSource({
      allowDownload: false,
      chromePath: undefined,
      chromePathCandidates: [],
      systemChromeUserDataDir: path.join(root, 'sys'),
      userDataDir,
    })
    expect(source).toEqual({ kind: 'profile' })
  })

  it('picks system Chrome when only it has the component', async () => {
    const root = await tmpDir()
    const systemDir = path.join(root, 'sys')
    await mkdir(path.join(systemDir, MODEL_COMPONENT_DIR), { recursive: true })
    const source = await findModelSource({
      allowDownload: false,
      chromePath: undefined,
      chromePathCandidates: [],
      systemChromeUserDataDir: systemDir,
      userDataDir: path.join(root, 'profile'),
    })
    expect(source).toEqual({ kind: 'system' })
  })

  it('allows a download when explicitly enabled', async () => {
    const root = await tmpDir()
    const source = await findModelSource({
      allowDownload: true,
      chromePath: undefined,
      chromePathCandidates: [],
      systemChromeUserDataDir: path.join(root, 'sys'),
      userDataDir: path.join(root, 'profile'),
    })
    expect(source).toEqual({ kind: 'download' })
  })

  it('returns a remedy reason when no component exists and downloads are off', async () => {
    const root = await tmpDir()
    const source = await findModelSource({
      allowDownload: false,
      chromePath: undefined,
      chromePathCandidates: [],
      systemChromeUserDataDir: path.join(root, 'sys'),
      userDataDir: path.join(root, 'profile'),
    })
    expect(source.kind).toBe('download')
    expect(source.reason).toContain('ODAI_NANO_ALLOW_DOWNLOAD')
  })
})

describe('readSystemLocalState', () => {
  it('extracts on-device prefs and the updater app entry', async () => {
    const root = await tmpDir()
    await writeFile(
      path.join(root, 'Local State'),
      JSON.stringify({
        optimization_guide: { on_device: { performance_class: 6 } },
        updateclientdata: {
          apps: { fklghjjljmnfjoepjmlobpekiapffcja: { pv: '9.9' } },
        },
      }),
    )
    const extract = await readSystemLocalState(root)
    expect(extract.onDevice['performance_class']).toBe(6)
    expect(extract.updaterApp).toEqual({ pv: '9.9' })
  })

  it('returns empty extract when Local State is absent', async () => {
    const root = await tmpDir()
    const extract = await readSystemLocalState(root)
    expect(extract).toEqual({ onDevice: {}, updaterApp: undefined })
  })
})

describe('cloneDir', () => {
  it('copies a directory tree recursively', async () => {
    const root = await tmpDir()
    const source = path.join(root, 'src')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'file.txt'), 'content')
    const target = path.join(root, 'dst')
    await cloneDir(source, target)
    expect(await readFile(path.join(target, 'file.txt'), 'utf8')).toBe(
      'content',
    )
  })
})

describe('ensureBridgeProfile', () => {
  it('clones the system component and seeds Local State in system mode', async () => {
    const root = await tmpDir()
    const systemDir = path.join(root, 'sys')
    await mkdir(path.join(systemDir, MODEL_COMPONENT_DIR), { recursive: true })
    await writeFile(
      path.join(systemDir, MODEL_COMPONENT_DIR, 'weights.bin'),
      'w',
    )
    await writeFile(
      path.join(systemDir, 'Local State'),
      JSON.stringify({
        optimization_guide: { on_device: { performance_class: 6 } },
      }),
    )
    const userDataDir = path.join(root, 'profile')
    const config: ResolvedBridgeConfig = {
      allowDownload: false,
      chromePath: path.join(root, 'chrome'),
      chromePathCandidates: [],
      systemChromeUserDataDir: systemDir,
      userDataDir,
    }
    const bridgePage = await ensureBridgeProfile(config, { kind: 'system' })
    expect(bridgePage.endsWith('.html')).toBe(true)
    expect(
      await readFile(
        path.join(userDataDir, MODEL_COMPONENT_DIR, 'weights.bin'),
        'utf8',
      ),
    ).toBe('w')
    const seeded = JSON.parse(
      await readFile(path.join(userDataDir, 'Local State'), 'utf8'),
    ) as { browser: { enabled_labs_experiments: string[] } }
    expect(seeded.browser.enabled_labs_experiments).toContain(
      'prompt-api-for-gemini-nano@1',
    )
  })

  it('seeds an empty Local State in download mode without cloning', async () => {
    const root = await tmpDir()
    const userDataDir = path.join(root, 'profile')
    const config: ResolvedBridgeConfig = {
      allowDownload: true,
      chromePath: path.join(root, 'chrome'),
      chromePathCandidates: [],
      systemChromeUserDataDir: path.join(root, 'no-sys'),
      userDataDir,
    }
    const bridgePage = await ensureBridgeProfile(config, { kind: 'download' })
    expect(bridgePage.endsWith('.html')).toBe(true)
    const seeded = JSON.parse(
      await readFile(path.join(userDataDir, 'Local State'), 'utf8'),
    ) as { optimization_guide: { on_device: Record<string, unknown> } }
    expect(seeded.optimization_guide.on_device).toBeDefined()
  })
})
