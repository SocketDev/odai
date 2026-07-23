import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createGeminiNanoHeadlessBackend,
  LOCAI_CHROME_ENV_VAR,
  LOCAI_NANO_ALLOW_DOWNLOAD_ENV_VAR,
  MODEL_COMPONENT_DIR,
} from '../../src/backends/gemini-nano-headless.mts'
import { createLocaiModel } from '../../src/model.mts'
import { LanguageModelSimulator } from '../../src/simulator.mts'
import type {
  BrowserContextLike,
  ChromiumLauncherLike,
  PageLike,
} from '../../src/backends/gemini-nano-headless.mts'

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'locai-nano-test-'))
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

describe('gemini-nano-headless backend', () => {
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
    const backend = createGeminiNanoHeadlessBackend({ env: {} })
    expect(await backend.availability()).toEqual({ available: true })
  })

  it('is unavailable with a Chrome remedy when no Chrome executable exists', async () => {
    const backend = createGeminiNanoHeadlessBackend({
      env: { [LOCAI_CHROME_ENV_VAR]: '/definitely/not/chrome' },
    })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('Google Chrome not found')
    expect(availability.reason).toContain('LOCAI_CHROME')
    expect(availability.reason).toContain('Chromium builds do not work')
  })

  it('is unavailable when no model component exists and downloads are off', async () => {
    const fixture = await createFixture()
    const backend = createGeminiNanoHeadlessBackend({
      chromePath: fixture.chromePath,
      env: {},
      systemChromeUserDataDir: path.join(fixture.systemDir, 'missing'),
      userDataDir: fixture.userDataDir,
    })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('OptGuideOnDeviceModel')
    expect(availability.reason).toContain('LOCAI_NANO_ALLOW_DOWNLOAD')
  })

  it('is available in system-Chrome mode when the model can be cloned', async () => {
    const fixture = await createFixture()
    const backend = createGeminiNanoHeadlessBackend({
      chromePath: fixture.chromePath,
      env: {},
      systemChromeUserDataDir: fixture.systemDir,
      userDataDir: fixture.userDataDir,
    })
    expect(await backend.availability()).toEqual({ available: true })
  })

  it('is available in CI mode when downloads are explicitly allowed', async () => {
    const fixture = await createFixture()
    const backend = createGeminiNanoHeadlessBackend({
      chromePath: fixture.chromePath,
      env: { [LOCAI_NANO_ALLOW_DOWNLOAD_ENV_VAR]: '1' },
      systemChromeUserDataDir: path.join(fixture.systemDir, 'missing'),
      userDataDir: fixture.userDataDir,
    })
    expect(await backend.availability()).toEqual({ available: true })
  })

  it('launches a throwaway profile seeded from system Chrome, never the live profile', async () => {
    const fixture = await createFixture()
    const fake = createFakeBrowser(new LanguageModelSimulator())
    const backend = createGeminiNanoHeadlessBackend({
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
            response: '{"summary":"nano says hi"}',
            when: text => text.includes('hello'),
          },
        ],
      }),
    )
    const backend = createGeminiNanoHeadlessBackend({
      chromePath: fixture.chromePath,
      env: {},
      launcher: fake.launcher,
      systemChromeUserDataDir: fixture.systemDir,
      userDataDir: fixture.userDataDir,
    })
    const factory = await backend.languageModel()
    const session = await factory.create({})
    const raw = await session.prompt([{ content: 'hello', role: 'user' }])
    expect(raw).toBe('{"summary":"nano says hi"}')
    await backend.close()
  })

  it('streams chunks across the page boundary', async () => {
    const fixture = await createFixture()
    const fake = createFakeBrowser(
      new LanguageModelSimulator({
        fallback: 'streamed reply from nano',
        rules: [],
      }),
    )
    const backend = createGeminiNanoHeadlessBackend({
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
    expect(chunks.join('')).toBe('streamed reply from nano')
    await backend.close()
  })

  it('drives createLocaiModel end to end through the bridge', async () => {
    const fixture = await createFixture()
    const fake = createFakeBrowser(
      new LanguageModelSimulator({
        fallback: '{"summary":"via seam"}',
        rules: [],
      }),
    )
    const backend = createGeminiNanoHeadlessBackend({
      chromePath: fixture.chromePath,
      env: {},
      launcher: fake.launcher,
      systemChromeUserDataDir: fixture.systemDir,
      userDataDir: fixture.userDataDir,
    })
    const model = await createLocaiModel({ backend })
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
    const backend = createGeminiNanoHeadlessBackend({
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
    const backend = createGeminiNanoHeadlessBackend({
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

describe.runIf(process.env['LOCAI_E2E'] === '1')(
  'gemini-nano-headless e2e (LOCAI_E2E=1)',
  () => {
    it(
      'prompts real Gemini Nano through headless system Chrome',
      { timeout: 300_000 },
      async () => {
        const userDataDir = await mkdtemp(
          path.join(os.tmpdir(), 'locai-nano-e2e-'),
        )
        const backend = createGeminiNanoHeadlessBackend({
          userDataDir: path.join(userDataDir, 'profile'),
        })
        const availability = await backend.availability()
        expect(availability.available).toBe(true)
        try {
          const model = await createLocaiModel({ backend })
          const result = await model.promptStreaming(
            'Reply with exactly: locai e2e live',
          )
          expect(result.raw.toLowerCase()).toContain('locai e2e live')
        } finally {
          await backend.close()
        }
      },
    )
  },
)
