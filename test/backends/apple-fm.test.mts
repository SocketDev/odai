import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import {
  checkAppleFmHost,
  createAppleFmBackend,
  shimCommandFromPath,
} from '../../src/backends/apple-fm.mts'
import { createLocaiModel } from '../../src/model.mts'
import type { ShimCommand } from '../../src/backends/apple-fm-shim.mts'
import type { Message, SessionLike } from '../../src/types.mts'

/**
 * Mock shim speaking the real line-delimited JSON protocol over a real child
 * process, with a mode argument steering the replies: `available`,
 * `deviceNotEligible`, `appleIntelligenceNotEnabled`, `json`,
 * `error-on-prompt`, `exit-on-prompt`, and the default echo mode that
 * reflects the prompt plus the create payload back as JSON.
 */
const MOCK_SHIM_SOURCE = `import readline from 'node:readline'

const mode = process.argv[2] ?? 'echo'
const rl = readline.createInterface({ input: process.stdin })
const reply = payload => process.stdout.write(JSON.stringify(payload) + '\\n')
let instructions
let temperature

rl.on('line', line => {
  const request = JSON.parse(line)
  if (request.op === 'availability') {
    if (mode === 'available' || mode === 'json' || mode === 'echo') {
      reply({ ok: true, availability: 'available' })
    } else {
      reply({ ok: true, availability: 'unavailable', reason: mode })
    }
  } else if (request.op === 'create') {
    instructions = request.instructions
    temperature = request.temperature
    reply({ ok: true })
  } else if (request.op === 'prompt') {
    if (mode === 'error-on-prompt') {
      reply({ ok: false, error: 'assetsUnavailable: Apple Intelligence is not enabled.' })
    } else if (mode === 'exit-on-prompt') {
      process.exit(1)
    } else if (mode === 'json') {
      reply({ ok: true, text: '\`\`\`json\\n{"summary":"apple fm speaks"}\\n\`\`\`' })
    } else {
      reply({ ok: true, text: JSON.stringify({ echo: request.prompt, instructions, temperature }) })
    }
  } else if (request.op === 'destroy') {
    reply({ ok: true })
    process.exit(0)
  } else {
    reply({ ok: false, error: 'unknown op ' + request.op })
  }
})
`

let mockShimPath = ''

function mockShim(mode: string): ShimCommand {
  return { args: [mockShimPath, mode], command: process.execPath }
}

async function createSession(
  mode: string,
  createOptions?: object | undefined,
): Promise<SessionLike> {
  const backend = createAppleFmBackend({ shim: mockShim(mode) })
  const factory = await backend.languageModel()
  return await factory.create(createOptions)
}

const hostIsAppleSilicon =
  process.platform === 'darwin' && process.arch === 'arm64'

describe('apple-fm backend', () => {
  beforeAll(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'locai-apple-fm-'))
    mockShimPath = path.join(dir, 'mock-shim.mjs')
    await writeFile(mockShimPath, MOCK_SHIM_SOURCE)
  })

  it('gates unsupported hosts with a precise reason', () => {
    const linux = checkAppleFmHost({
      arch: 'x64',
      darwinMajor: 0,
      platform: 'linux',
    })
    expect(linux.supported).toBe(false)
    expect(linux.reason).toContain('macOS 26')
    const intelMac = checkAppleFmHost({
      arch: 'x64',
      darwinMajor: 25,
      platform: 'darwin',
    })
    expect(intelMac.supported).toBe(false)
    expect(intelMac.reason).toContain('Apple silicon')
    const oldMac = checkAppleFmHost({
      arch: 'arm64',
      darwinMajor: 24,
      platform: 'darwin',
    })
    expect(oldMac.supported).toBe(false)
    expect(oldMac.reason).toContain('Darwin kernel 24')
    expect(
      checkAppleFmHost({ arch: 'arm64', darwinMajor: 25, platform: 'darwin' }),
    ).toEqual({ supported: true })
  })

  it('reports available when the shim says available', async () => {
    const backend = createAppleFmBackend({ shim: mockShim('available') })
    expect(await backend.availability()).toEqual({ available: true })
  })

  it('maps deviceNotEligible to a VM-aware reason', async () => {
    const backend = createAppleFmBackend({
      shim: mockShim('deviceNotEligible'),
    })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('deviceNotEligible')
    expect(availability.reason).toContain('VMs')
  })

  it('maps appleIntelligenceNotEnabled to enablement guidance', async () => {
    const backend = createAppleFmBackend({
      shim: mockShim('appleIntelligenceNotEnabled'),
    })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('appleIntelligenceNotEnabled')
    expect(availability.reason).toContain('System Settings')
  })

  it('honors the LOCAI_APPLE_FM_SHIM env override', async () => {
    const backend = createAppleFmBackend({
      env: {
        LOCAI_APPLE_FM_SHIM: mockShimPath,
      },
    })
    const availability = await backend.availability()
    expect(availability).toEqual({ available: true })
  })

  it('resolves script overrides through the Node executable', () => {
    expect(shimCommandFromPath('/tmp/shim.mjs')).toEqual({
      args: ['/tmp/shim.mjs'],
      command: process.execPath,
    })
    expect(shimCommandFromPath('/tmp/apple-fm-shim')).toEqual({
      args: [],
      command: '/tmp/apple-fm-shim',
    })
  })

  it('reports a spawn failure as the unavailability reason', async () => {
    const backend = createAppleFmBackend({
      shim: { args: [], command: '/nonexistent/locai-shim' },
    })
    const availability = await backend.availability()
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('shim')
  })

  it('sends instructions and temperature to the shim and drops topK', async () => {
    const model = await createLocaiModel({
      backend: createAppleFmBackend({ shim: mockShim('echo') }),
      systemPrompt: 'You are terse.',
      temperature: 0.2,
      topK: 3,
    })
    const result = await model.promptStreaming('hello shim')
    const echoed = JSON.parse(result.raw) as {
      echo: string
      instructions: string
      temperature: number
    }
    expect(echoed.instructions).toBe('You are terse.')
    expect(echoed.temperature).toBe(0.2)
    expect(echoed.echo).toBe('hello shim')
  })

  it('flattens roles into a transcript ending on the assistant prefill', async () => {
    const session = await createSession('echo')
    const messages: Message[] = [
      { content: 'Reply with JSON.', role: 'system' },
      { content: 'dedupe lodash', role: 'user' },
      { content: '{"summary":"', role: 'assistant' },
    ]
    const raw = await session.prompt(messages)
    const echoed = JSON.parse(raw) as { echo: string }
    expect(echoed.echo).toContain('Reply with JSON.')
    expect(echoed.echo).toContain('User: dedupe lodash')
    expect(echoed.echo.endsWith('Assistant: {"summary":"')).toBe(true)
  })

  it('drives promptStructured through the JSON repair path', async () => {
    const model = await createLocaiModel({
      backend: createAppleFmBackend({ shim: mockShim('json') }),
    })
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
    expect(result.data?.summary).toBe('apple fm speaks')
  })

  it('surfaces the shim error when a prompt fails', async () => {
    const session = await createSession('error-on-prompt')
    await expect(
      session.prompt([{ content: 'hi', role: 'user' }]),
    ).rejects.toThrow(/Apple Intelligence is not enabled/)
  })

  it('rejects the pending prompt when the shim process dies', async () => {
    const session = await createSession('exit-on-prompt')
    await expect(
      session.prompt([{ content: 'hi', role: 'user' }]),
    ).rejects.toThrow(/exited/)
  })

  it('streams the full reply as a single chunk in v1', async () => {
    const session = await createSession('json')
    const chunks: string[] = []
    for await (const chunk of session.promptStreaming([
      { content: 'summarize', role: 'user' },
    ]) as AsyncIterable<string>) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('apple fm speaks')
  })

  // Every honest outcome mentions Apple: available, a FoundationModels
  // reason, or a missing-Swift-toolchain build failure.
  it.runIf(hostIsAppleSilicon)(
    'compiles the real Swift shim and probes FoundationModels honestly',
    { timeout: 240_000 },
    async () => {
      const backend = createAppleFmBackend({ env: {} })
      const availability = await backend.availability()
      const observed = availability.available
        ? 'available'
        : String(availability.reason)
      expect(observed).toMatch(/^available$|Apple/)
    },
  )
})
