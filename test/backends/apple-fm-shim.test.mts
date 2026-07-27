import crypto from 'node:crypto'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  APPLE_FM_SHIM_SOURCE,
  createShimSession,
  currentHost,
  ensureShimBinary,
  flattenMessages,
  isExecutable,
  spawnShim,
  unrefStream,
} from '../../src/backends/apple-fm-shim.mts'
import { tolerantSleep } from '../fleet/_shared/lib/timing.mts'
import type { ShimCommand } from '../../src/backends/apple-fm-shim.mts'
import type { Message } from '../../src/types.mts'

let scratch = ''

/**
 * A line-delimited JSON shim written to disk and run with the current Node.
 * `mode` steers replies: `echo`, `unparseable`, `hang`, `exit-clean`.
 */
async function writeShim(name: string, body: string): Promise<ShimCommand> {
  const file = path.join(scratch, name)
  await writeFile(file, body)
  return { args: [file], command: process.execPath }
}

describe('apple-fm shim internals', () => {
  beforeAll(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'odai-apple-shim-'))
  })

  afterAll(() => {
    /* temp dir is cleaned by the OS; nothing to tear down */
  })

  describe('flattenMessages', () => {
    it('passes a lone user message through untouched', () => {
      expect(flattenMessages([{ content: 'just this', role: 'user' }])).toBe(
        'just this',
      )
    })

    it('builds a role-tagged transcript for richer conversations', () => {
      const messages: Message[] = [
        { content: 'Be terse.', role: 'system' },
        { content: 'summarize', role: 'user' },
        { content: '{"summary":"', role: 'assistant' },
      ]
      expect(flattenMessages(messages)).toBe(
        'Be terse.\n\nUser: summarize\n\nAssistant: {"summary":"',
      )
    })

    it('skips undefined slots in the message array', () => {
      const messages = [
        { content: 'a', role: 'user' },
        undefined,
        { content: 'b', role: 'user' },
      ] as unknown as Message[]
      expect(flattenMessages(messages)).toBe('User: a\n\nUser: b')
    })
  })

  describe('currentHost', () => {
    it('reports this process arch, platform, and darwin major', () => {
      const host = currentHost()
      expect(host.arch).toBe(process.arch)
      expect(host.platform).toBe(process.platform)
      expect(typeof host.darwinMajor).toBe('number')
    })
  })

  describe('isExecutable', () => {
    it('is true for an executable file and false for a missing one', async () => {
      const file = path.join(scratch, 'runnable.sh')
      await writeFile(file, '#!/bin/sh\n')
      await chmod(file, 0o755)
      expect(await isExecutable(file)).toBe(true)
      expect(await isExecutable(path.join(scratch, 'nope'))).toBe(false)
    })
  })

  describe('unrefStream', () => {
    it('calls unref when present and tolerates its absence', () => {
      let unreffed = false
      unrefStream({ unref: () => (unreffed = true) })
      expect(unreffed).toBe(true)
      // A JSON-parsed null models the spawn wrapper's absent stream slot.
      expect(() => unrefStream(JSON.parse('null'))).not.toThrow()
      expect(() => unrefStream({})).not.toThrow()
    })
  })

  describe('ensureShimBinary', () => {
    it('returns a cached executable and shares concurrent builds', async () => {
      const key = crypto
        .createHash('sha256')
        .update(APPLE_FM_SHIM_SOURCE)
        .digest('hex')
        .slice(0, 16)
      const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'odai-shim-cache-'))
      const binaryPath = path.join(cacheDir, `apple-fm-shim-${key}`)
      await writeFile(binaryPath, '#!/bin/sh\n')
      await chmod(binaryPath, 0o755)
      const [first, second] = await Promise.all([
        ensureShimBinary(cacheDir),
        ensureShimBinary(cacheDir),
      ])
      expect(first).toBe(binaryPath)
      expect(second).toBe(binaryPath)
    })
  })

  describe('spawnShim', () => {
    it('rejects an unparseable reply line', async () => {
      const command = await writeShim(
        'unparseable.mjs',
        `import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', () => { process.stdout.write('not json\\n') })
`,
      )
      const handle = spawnShim(command)
      await expect(
        handle.request({ op: 'availability' }, 5000),
      ).rejects.toThrow(/unparseable reply/)
      handle.dispose()
    })

    it('times out a silent shim and kills it', async () => {
      const command = await writeShim(
        'hang.mjs',
        `import readline from 'node:readline'
readline.createInterface({ input: process.stdin }).on('line', () => {})
`,
      )
      const handle = spawnShim(command)
      await expect(handle.request({ op: 'availability' }, 80)).rejects.toThrow(
        /timed out after 80ms/,
      )
      handle.dispose()
    })

    it('fails pending requests when the shim exits', async () => {
      const command = await writeShim(
        'exit-clean.mjs',
        `import readline from 'node:readline'
readline.createInterface({ input: process.stdin }).on('line', () => { process.exit(0) })
`,
      )
      const handle = spawnShim(command)
      await expect(
        handle.request({ op: 'availability' }, 5000),
      ).rejects.toThrow(/shim exited/)
    })

    it('rejects a request issued after the shim has exited', async () => {
      const command = await writeShim(
        'exit-now.mjs',
        `process.exit(0)
`,
      )
      const handle = spawnShim(command)
      // Give the process time to exit and settle the spawn promise.
      await new Promise(resolve => setTimeout(resolve, tolerantSleep(200)))
      await expect(
        handle.request({ op: 'availability' }, 5000),
      ).rejects.toThrow(/already exited/)
      handle.dispose()
    })
  })

  describe('createShimSession', () => {
    it('prompts, clones into a fresh session, and destroys the handle', async () => {
      const command = await writeShim(
        'echo.mjs',
        `import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const reply = p => process.stdout.write(JSON.stringify(p) + '\\n')
rl.on('line', line => {
  const req = JSON.parse(line)
  if (req.op === 'create') { reply({ ok: true }) }
  else if (req.op === 'prompt') { reply({ ok: true, text: 'echo:' + req.prompt }) }
  else { reply({ ok: true }) }
})
`,
      )
      const session = createShimSession({
        command,
        instructions: 'be terse',
        temperature: 0.3,
      })
      const raw = await session.prompt([{ content: 'hello', role: 'user' }])
      expect(raw).toBe('echo:hello')
      const cloned = session.clone!()
      const clonedRaw = await cloned.prompt([
        { content: 'world', role: 'user' },
      ])
      expect(clonedRaw).toBe('echo:world')
      session.destroy!()
      cloned.destroy!()
    })

    it('throws when the shim reports a create failure', async () => {
      const command = await writeShim(
        'create-fail.mjs',
        `import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', () => { process.stdout.write(JSON.stringify({ ok: false, error: 'no assets' }) + '\\n') })
`,
      )
      const session = createShimSession({ command })
      await expect(
        session.prompt([{ content: 'hi', role: 'user' }]),
      ).rejects.toThrow(/no assets/)
    })
  })
})
