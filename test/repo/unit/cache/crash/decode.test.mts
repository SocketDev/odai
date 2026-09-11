import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import {
  decodeGemmaCrash,
  parseGemmaDisassembly,
} from '../../../../../scripts/repo/cache/crash/decode.mts'

test.each([
  ['   0:\tud1    %eax,%eax', 'ud1'],
  ['   0:\tdata16 ud2', 'data16 ud2'],
  ['   0:\tendbr64', 'endbr64'],
  ['   0:\tvpdpbusd %zmm0,%zmm1,%zmm2', 'vpdpbusd'],
  ['   0:\t(bad)', undefined],
  ['   0:\t.byte 0xc4', undefined],
  ['   1:\tud2', undefined],
  ['   0:\tprivate/path', undefined],
] as const)('retains only the decoded mnemonic from %s', (output, wanted) => {
  expect(parseGemmaDisassembly(output)).toBe(wanted)
})
test('rejects oversized decoder output', () => {
  expect(parseGemmaDisassembly(' '.repeat(8193))).toBeUndefined()
})
test('malformed dumps never invoke a decoder', async () => {
  expect(await decodeGemmaCrash(new Uint8Array())).toEqual({
    status: 'unavailable',
  })
})

const state = vi.hoisted(() => ({ spawn: vi.fn() }))

function decoderFixture(): Buffer {
  const bytes = Buffer.alloc(1024)
  bytes.writeUInt32LE(0x50_4d_44_4d, 0)
  bytes.writeUInt32LE(0xa7_93, 4)
  bytes.writeUInt32LE(4, 8)
  bytes.writeUInt32LE(32, 12)
  for (const [index, values] of [
    [6, 168, 80],
    [7, 56, 248],
    [4, 4, 304],
    [5, 20, 308],
  ].entries()) {
    for (const [field, value] of values.entries()) {
      bytes.writeUInt32LE(value, 32 + index * 12 + field * 4)
    }
  }
  bytes.writeUInt32LE(4, 88)
  bytes.writeUInt16LE(9, 248)
  bytes.writeUInt32LE(0x82_01, 268)
  bytes.writeUInt32LE(256, 240)
  bytes.writeUInt32LE(400, 244)
  bytes.writeUInt32LE(0x10_00_01, 448)
  bytes.writeBigUInt64LE(0x10_00n, 648)
  bytes.writeUInt32LE(1, 308)
  bytes.writeBigUInt64LE(0x10_00n, 312)
  bytes.writeUInt32LE(3, 320)
  bytes.writeUInt32LE(800, 324)
  bytes.set([0x0f, 0xb9, 0xc0], 800)
  return bytes
}

test('decodes through a bounded process and deletes transient bytes', async () => {
  let temporary = ''
  state.spawn.mockImplementation(
    async (
      command: string,
      args: string[],
      options: { timeout: number; maxBuffer: number },
    ) => {
      expect(command).toBe(
        '/opt/odai-cache/decoder/usr/bin/x86_64-linux-gnu-objdump',
      )
      expect(options.timeout).toBe(5000)
      expect(options.maxBuffer).toBe(8192)
      temporary = args.at(-1)!
      expect(await fs.readFile(temporary)).toEqual(
        Buffer.from([0x0f, 0xb9, 0xc0]),
      )
      return { stdout: '   0:\tud1 %eax,%eax\n', stderr: '' }
    },
  )
  const result = await decodeGemmaCrash(decoderFixture(), {
    execute: state.spawn,
  })
  expect(result).toMatchObject({
    diagnosis: {
      status: 'captured',
      mnemonic: 'ud1',
      module: 'no-match',
      symbols: 'unavailable',
    },
  })
  expect(existsSync(temporary)).toBe(false)
  expect(JSON.stringify(result)).not.toContain(temporary)
})

test('decoder process failure preserves crash evidence and removes bytes', async () => {
  let temporary = ''
  state.spawn.mockImplementation(async (command: string, args: string[]) => {
    expect(command.endsWith('objdump')).toBe(true)
    temporary = args.at(-1)!
    throw new Error('example decoder failure')
  })
  expect(
    await decodeGemmaCrash(decoderFixture(), { execute: state.spawn }),
  ).toMatchObject({
    status: 'captured',
    signal: 4,
    diagnosis: { status: 'unavailable' },
  })
  expect(existsSync(temporary)).toBe(false)
})
