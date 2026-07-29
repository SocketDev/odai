import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createChromeBuiltinBackend,
  loadLauncher,
  MODEL_COMPONENT_DIR,
  ODAI_CHROME_ALLOW_DOWNLOAD_ENV_VAR,
  ODAI_CHROME_ENV_VAR,
  startBridge,
} from '../../src/backends/chrome-builtin.mts'
import { createOdaiModel } from '../../src/model.mts'
import { LanguageModelSimulator } from '../../src/simulator.mts'
import type {
  BrowserContextLike,
  ChromiumLauncherLike,
  PageLike,
} from '../../src/backends/chrome-builtin.mts'

// odai delegates built-in model resolution to socket-lib's `ai/builtin`, whose
// real resolver probes the runtime once and caches. Mock it to re-read the
// per-case `globalThis.LanguageModel` install on every call.
vi.mock(import('@socketsecurity/lib/ai/builtin'), () => ({
  getLanguageModel: () =>
    (globalThis as { LanguageModel?: unknown | undefined }).LanguageModel ??
    undefined,
}))

interface FakeBrowser {
  closed: boolean
  exposed: Map<string, (arg: never) => unknown>
  gotoUrls: string[]
  launcher: ChromiumLauncherLike
  launches: Array<{ options: Record<string, unknown>; userDataDir: string }>
}

/**
 * Fake at the playwright boundary. `evaluate(fn, arg)` runs the serialized
 * page function in-process with a `LanguageModel` global installed, so the
 * page side of the bridge executes for real against the simulator.
 */
function createFakeBrowser(languageModel: unknown): FakeBrowser {
  const fake: FakeBrowser = {
    closed: false,
    exposed: new Map(),
    gotoUrls: [],
    launcher: {
      async launchPersistentContext(
        userDataDir: string,
        options: object,
      ): Promise<BrowserContextLike> {
        fake.launches.push({
          options: options as Record<string, unknown>,
          userDataDir,
        })
        const page: PageLike = {
          async evaluate<T>(
            fn: unknown,
            arg?: unknown | undefined,
          ): Promise<T> {
            const holder = globalThis as Record<string, unknown>
            const previousModel = holder['LanguageModel']
            const previousBindings = new Map<string, unknown>()
            holder['LanguageModel'] = languageModel
            for (const [name, callback] of fake.exposed) {
              previousBindings.set(name, holder[name])
              holder[name] = async (bindingArg: never) => callback(bindingArg)
            }
            try {
              return (await (fn as (value: unknown) => unknown)(arg)) as T
            } finally {
              holder['LanguageModel'] = previousModel
              for (const [name, previous] of previousBindings) {
                holder[name] = previous
              }
            }
          },
          async exposeFunction(
            name: string,
            callback: (arg: never) => unknown,
          ): Promise<void> {
            fake.exposed.set(name, callback)
          },
          async goto(url: string): Promise<void> {
            fake.gotoUrls.push(url)
          },
        }
        return {
          async close(): Promise<void> {
            fake.closed = true
          },
          async newPage(): Promise<PageLike> {
            return page
          },
        }
      },
    },
    launches: [],
  }
  return fake
}

interface Fixture {
  chromePath: string
  systemDir: string
  userDataDir: string
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'odai-chrome-test-'))
  const chromePath = path.join(root, 'chrome')
  await writeFile(chromePath, '#!/bin/sh\n')
  const systemDir = path.join(root, 'system-chrome')
  await mkdir(path.join(systemDir, MODEL_COMPONENT_DIR, '2025.8.8.1141'), {
    recursive: true,
  })
  await writeFile(
    path.join(systemDir, MODEL_COMPONENT_DIR, '2025.8.8.1141', 'weights.bin'),
    'weights',
  )
  await writeFile(
    path.join(systemDir, 'Local State'),
    JSON.stringify({
      optimization_guide: {
        on_device: { performance_class: 6 },
      },
      updateclientdata: {
        apps: { fklghjjljmnfjoepjmlobpekiapffcja: { pv: '2025.8.8.1141' } },
      },
    }),
  )
  return {
    chromePath,
    systemDir,
    userDataDir: path.join(root, 'bridge-profile'),
  }
}

describe('chrome-builtin backend', () => {
  let originalLanguageModel: unknown

  beforeEach(() => {
    originalLanguageModel = (globalThis as Record<string, unknown>)[
      'LanguageModel'
    ]
    ;(globalThis as Record<string, unknown>)['LanguageModel'] = undefined
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>)['LanguageModel'] =
      originalLanguageModel
  })

  it('reports available when the runtime LanguageModel global is usable', async () => {
    ;(globalThis as Record<string, unknown>)['LanguageModel'] =
      new LanguageModelSimulator()
    const backend = createChromeBuiltinBackend({ env: {} })
    expect(await backend.availability()).toEqual({ available: true })
  })

  it('is unavailable with a Chrome remedy when no Chrome executable exists', async () => {
    const backend = createChromeBuiltinBackend({
      env: { [ODAI_CHROME_ENV_VAR]: '/definitely/not/chrome' },
    })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('Google Chrome not found')
    expect(availability.reason).toContain('ODAI_CHROME')
    expect(availability.reason).toContain('Chromium builds do not work')
  })

  it('is unavailable when no model component exists and downloads are off', async () => {
    const fixture = await createFixture()
    const backend = createChromeBuiltinBackend({
      chromePath: fixture.chromePath,
      env: {},
      systemChromeUserDataDir: path.join(fixture.systemDir, 'missing'),
      userDataDir: fixture.userDataDir,
    })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('OptGuideOnDeviceModel')
    expect(availability.reason).toContain('ODAI_CHROME_ALLOW_DOWNLOAD')
  })

  it('is available in system-Chrome mode when the model can be cloned', async () => {
    const fixture = await createFixture()
    const backend = createChromeBuiltinBackend({
      chromePath: fixture.chromePath,
      env: {},
      systemChromeUserDataDir: fixture.systemDir,
      userDataDir: fixture.userDataDir,
    })
    expect(await backend.availability()).toEqual({ available: true })
  })

  it('is available in CI mode when downloads are explicitly allowed', async () => {
    const fixture = await createFixture()
    const backend = createChromeBuiltinBackend({
      chromePath: fixture.chromePath,
      env: { [ODAI_CHROME_ALLOW_DOWNLOAD_ENV_VAR]: '1' },
      systemChromeUserDataDir: path.join(fixture.systemDir, 'missing'),
      userDataDir: fixture.userDataDir,
    })
    expect(await backend.availability()).toEqual({ available: true })
  })

  it('launches a throwaway profile seeded from system Chrome, never the live profile', async () => {
    const fixture = await createFixture()
    const fake = createFakeBrowser(new LanguageModelSimulator())
    const backend = createChromeBuiltinBackend({
      chromePath: fixture.chromePath,
      env: {},
      launcher: fake.launcher,
      systemChromeUserDataDir: fixture.systemDir,
      userDataDir: fixture.userDataDir,
    })
    await backend.languageModel()
    expect(fake.launches).toHaveLength(1)
    const launch = fake.launches[0]
    expect(launch.userDataDir).toBe(fixture.userDataDir)
    expect(launch.userDataDir).not.toBe(fixture.systemDir)
    expect(launch.options['executablePath']).toBe(fixture.chromePath)
    expect(launch.options['headless']).toBe(true)
    // The model component was cloned into the bridge profile.
    const cloned = await readFile(
      path.join(
        fixture.userDataDir,
        MODEL_COMPONENT_DIR,
        '2025.8.8.1141',
        'weights.bin',
      ),
      'utf8',
    )
    expect(cloned).toBe('weights')
    // The system profile Local State stays untouched; the bridge profile
    // carries the activation seed.
    const seeded = JSON.parse(
      await readFile(path.join(fixture.userDataDir, 'Local State'), 'utf8'),
    ) as {
      browser: { enabled_labs_experiments: string[] }
      optimization_guide: {
        model_execution: { last_usage_by_feature: Record<string, string> }
      }
    }
    expect(seeded.browser.enabled_labs_experiments).toContain(
      'prompt-api-for-gemini-nano@1',
    )
    expect(
      seeded.optimization_guide.model_execution.last_usage_by_feature['6'],
    ).toBeDefined()
    // The bridge page is a file:// secure context, not about:blank.
    expect(fake.gotoUrls[0]).toMatch(/^file:\/\//)
    await backend.close()
    expect(fake.closed).toBe(true)
  })

  it('round-trips a real prompt through the page-proxied session', async () => {
    const fixture = await createFixture()
    const fake = createFakeBrowser(
      new LanguageModelSimulator({
        fallback: '{"summary":"canned"}',
        rules: [
          {
            response: '{"summary":"builtin says hi"}',
            when: text => text.includes('hello'),
          },
        ],
      }),
    )
    const backend = createChromeBuiltinBackend({
      chromePath: fixture.chromePath,
      env: {},
      launcher: fake.launcher,
      systemChromeUserDataDir: fixture.systemDir,
      userDataDir: fixture.userDataDir,
    })
    const factory = await backend.languageModel()
    const session = await factory.create({})
    const raw = await session.prompt([{ content: 'hello', role: 'user' }])
    expect(raw).toBe('{"summary":"builtin says hi"}')
    await backend.close()
  })

  it('streams chunks across the page boundary', async () => {
    const fixture = await createFixture()
    const fake = createFakeBrowser(
      new LanguageModelSimulator({
        fallback: 'streamed reply from builtin',
        rules: [],
      }),
    )
    const backend = createChromeBuiltinBackend({
      chromePath: fixture.chromePath,
      env: {},
      launcher: fake.launcher,
      systemChromeUserDataDir: fixture.systemDir,
      userDataDir: fixture.userDataDir,
    })
    const factory = await backend.languageModel()
    const session = await factory.create({})
    const chunks: string[] = []
    for await (const chunk of session.promptStreaming([
      { content: 'stream please', role: 'user' },
    ]) as AsyncIterable<string>) {
      chunks.push(chunk)
    }
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.join('')).toBe('streamed reply from builtin')
    await backend.close()
  })

  it('drives createOdaiModel end to end through the bridge', async () => {
    const fixture = await createFixture()
    const fake = createFakeBrowser(
      new LanguageModelSimulator({
        fallback: '{"summary":"via seam"}',
        rules: [],
      }),
    )
    const backend = createChromeBuiltinBackend({
      chromePath: fixture.chromePath,
      env: {},
      launcher: fake.launcher,
      systemChromeUserDataDir: fixture.systemDir,
      userDataDir: fixture.userDataDir,
    })
    const model = await createOdaiModel({ backend })
    const result = await model.promptStructured<{ summary: string }>(
      'summarize',
      {
        prefill: '{"summary":"',
        schema: {
          parse(value: unknown): { summary: string } {
            const record = value as { summary?: unknown | undefined }
            if (typeof record.summary !== 'string') {
              throw new TypeError('summary must be a string')
            }
            return { summary: record.summary }
          },
        },
      },
    )
    expect(result.ok).toBe(true)
    expect(result.data?.summary).toBe('via seam')
    await backend.close()
  })

  it('surfaces page-side create errors with their original error name', async () => {
    const fixture = await createFixture()
    const throwingModel = {
      async availability(): Promise<string> {
        return 'available'
      },
      async create(): Promise<never> {
        throw new TypeError('temperature is not supported')
      },
    }
    const fake = createFakeBrowser(throwingModel)
    const backend = createChromeBuiltinBackend({
      chromePath: fixture.chromePath,
      env: {},
      launcher: fake.launcher,
      systemChromeUserDataDir: fixture.systemDir,
      userDataDir: fixture.userDataDir,
    })
    const factory = await backend.languageModel()
    await expect(factory.create({ temperature: 2 })).rejects.toMatchObject({
      message: 'temperature is not supported',
      name: 'TypeError',
    })
    await backend.close()
  })

  it('reports the on-device reason when the global is present but not available', async () => {
    ;(globalThis as Record<string, unknown>)['LanguageModel'] = {
      async availability(): Promise<string> {
        return 'downloadable'
      },
      async create(): Promise<never> {
        throw new Error('not available')
      },
    }
    const backend = createChromeBuiltinBackend({ env: {} })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('not')
  })

  it('returns a factory backed by the runtime LanguageModel global from languageModel', async () => {
    const model = new LanguageModelSimulator()
    ;(globalThis as Record<string, unknown>)['LanguageModel'] = model
    const backend = createChromeBuiltinBackend({ env: {} })
    const factory = await backend.languageModel()
    // The runtime global is used (not the headless bridge); odai adapts it to
    // the session seam, so assert delegation rather than object identity.
    expect(await factory.availability()).toBe('available')
    const session = await factory.create()
    expect(typeof session.prompt).toBe('function')
  })

  it('resolves a real playwright launcher when none is injected', async () => {
    const resolved = await loadLauncher({})
    expect(resolved.reason).toBeUndefined()
    expect(typeof resolved.launcher?.launchPersistentContext).toBe('function')
  })

  it('startBridge throws the Chrome-missing remedy when Chrome is absent', async () => {
    const fixture = await createFixture()
    await expect(
      startBridge({
        chromePath: '/definitely/not/chrome',
        env: {},
        launcher: createFakeBrowser(new LanguageModelSimulator()).launcher,
        systemChromeUserDataDir: fixture.systemDir,
        userDataDir: fixture.userDataDir,
      }),
    ).rejects.toThrow(/Google Chrome not found/)
  })

  it('startBridge throws the model-source reason when no component exists', async () => {
    const fixture = await createFixture()
    await expect(
      startBridge({
        chromePath: fixture.chromePath,
        env: {},
        launcher: createFakeBrowser(new LanguageModelSimulator()).launcher,
        systemChromeUserDataDir: path.join(fixture.systemDir, 'missing'),
        userDataDir: fixture.userDataDir,
      }),
    ).rejects.toThrow(/no Chrome built-in AI model component/)
  })

  it('fails with the wait reason when the model never becomes available', async () => {
    const fixture = await createFixture()
    const stuckModel = {
      async availability(): Promise<string> {
        return 'downloading'
      },
      async create(): Promise<never> {
        throw new Error('unreachable')
      },
    }
    const fake = createFakeBrowser(stuckModel)
    const backend = createChromeBuiltinBackend({
      chromePath: fixture.chromePath,
      env: {},
      launcher: fake.launcher,
      readyTimeoutMs: 50,
      systemChromeUserDataDir: fixture.systemDir,
      userDataDir: fixture.userDataDir,
    })
    await expect(backend.languageModel()).rejects.toThrow(
      /did not become available.*downloading/s,
    )
    expect(fake.closed).toBe(true)
    await backend.close()
  })
})

describe.runIf(process.env['ODAI_E2E'] === '1')(
  'chrome-builtin e2e (ODAI_E2E=1)',
  () => {
    it(
      'prompts the real on-device model through headless system Chrome',
      { timeout: 300_000 },
      async () => {
        const userDataDir = await mkdtemp(
          path.join(os.tmpdir(), 'odai-chrome-e2e-'),
        )
        const backend = createChromeBuiltinBackend({
          userDataDir: path.join(userDataDir, 'profile'),
        })
        const availability = await backend.availability()
        expect(availability.available).toBe(true)
        try {
          const model = await createOdaiModel({ backend })
          const result = await model.promptStreaming(
            'Reply with exactly: odai e2e live',
          )
          expect(result.raw.toLowerCase()).toContain('odai e2e live')
        } finally {
          await backend.close()
        }
      },
    )
  },
)
