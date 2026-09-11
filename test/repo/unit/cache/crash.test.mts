import { expect, test } from 'vitest'
import {
  parseGemmaCrash,
  readGemmaCrashDetails,
} from '../../../../scripts/repo/cache/crash.mts'

function crashFixture(): Buffer {
  const bytes = Buffer.alloc(1024)
  bytes.writeUInt32LE(0x50_4d_44_4d, 0)
  bytes.writeUInt32LE(0xa7_93, 4)
  bytes.writeUInt32LE(3, 8)
  bytes.writeUInt32LE(32, 12)
  const streams = [
    [6, 168, 80],
    [7, 56, 248],
    [4, 112, 304],
  ]
  for (let index = 0; index < streams.length; index += 1) {
    const row = streams[index]!
    for (let field = 0; field < 3; field += 1) {
      bytes.writeUInt32LE(row[field]!, 32 + index * 12 + field * 4)
    }
  }
  bytes.writeUInt32LE(4, 88)
  bytes.writeUInt32LE(2, 92)
  bytes.writeBigUInt64LE(0x10_10n, 104)
  bytes.writeUInt16LE(9, 248)
  bytes.writeUInt32LE(0x82_01, 268)
  bytes.writeUInt32LE(1, 304)
  bytes.writeBigUInt64LE(0x10_00n, 308)
  bytes.writeUInt32LE(0x1_00, 316)
  bytes.writeUInt32LE(420, 328)
  const name = '/private/example/liboptimization_guide_internal.so'
  bytes.writeUInt32LE(name.length * 2, 420)
  bytes.write(name, 424, 'utf16le')
  return bytes
}

test('returns Linux exception metadata without private payload', () => {
  const result = parseGemmaCrash(crashFixture())
  expect(result).toEqual({
    status: 'captured',
    exceptionCode: 4,
    exceptionFlags: 2,
    signal: 4,
    exceptionModule: 'liboptimization_guide_internal.so',
    instruction: { status: 'unavailable' },
  })
  expect(JSON.stringify(result)).not.toContain('private')
})

test('does not interpret other platforms or unknown exception codes as Linux signals', () => {
  const windows = crashFixture()
  windows.writeUInt32LE(2, 268)
  expect(parseGemmaCrash(windows)).not.toHaveProperty('signal')
  const unknown = crashFixture()
  unknown.writeUInt32LE(0xff_ff, 88)
  expect(parseGemmaCrash(unknown)).toMatchObject({
    status: 'captured',
    exceptionCode: 0xff_ff,
  })
  expect(parseGemmaCrash(unknown)).not.toHaveProperty('signal')
})

test('matches address ranges without leaking unapproved module names', () => {
  const outside = crashFixture()
  outside.writeBigUInt64LE(0x11_00n, 104)
  expect(parseGemmaCrash(outside)).not.toHaveProperty('exceptionModule')
  const privateModule = crashFixture()
  const name = '/private/example/private-module.so'
  privateModule.fill(0, 420)
  privateModule.writeUInt32LE(name.length * 2, 420)
  privateModule.write(name, 424, 'utf16le')
  expect(parseGemmaCrash(privateModule)).toMatchObject({ status: 'captured' })
  expect(parseGemmaCrash(privateModule)).not.toHaveProperty('exceptionModule')
  expect(JSON.stringify(parseGemmaCrash(privateModule))).not.toContain(
    'private',
  )
})

test.each([
  ['signature', 0, 0],
  ['version', 4, 0],
  ['stream count', 8, 129],
  ['directory bounds', 12, 1020],
  ['stream bounds', 40, 1020],
  ['duplicate streams', 44, 6],
  ['overlapping streams', 52, 100],
  ['system version bounds', 272, 1020],
  ['exception size', 36, 167],
  ['exception parameters', 112, 16],
  ['context bounds', 244, 1025],
  ['module count', 304, 513],
  ['module name bounds', 328, 1020],
  ['module name length', 420, 1026],
  ['module odd name length', 420, 3],
  ['debug record bounds', 388, 1025],
] as const)('rejects malformed %s', (name, offset, value) => {
  expect(name.length).toBeGreaterThan(0)
  const bytes = crashFixture()
  bytes.writeUInt32LE(value, offset)
  expect(parseGemmaCrash(bytes)).toEqual({ status: 'unavailable' })
})

test('rejects truncated and oversized inputs', () => {
  const bytes = crashFixture()
  expect(parseGemmaCrash(bytes.subarray(0, 24))).toEqual({
    status: 'unavailable',
  })
  expect(parseGemmaCrash(bytes.subarray(0, 512))).toEqual({
    status: 'unavailable',
  })
  expect(parseGemmaCrash(new Uint8Array(16 * 1024 * 1024 + 1))).toEqual({
    status: 'unavailable',
  })
})

test('honors the input view offset', () => {
  const framed = Buffer.concat([
    Buffer.alloc(17),
    crashFixture(),
    Buffer.alloc(9),
  ])
  expect(parseGemmaCrash(framed.subarray(17, 1041))).toMatchObject({
    status: 'captured',
    signal: 4,
  })
})

function instructionFixture(opcode: number[]): Buffer {
  const bytes = Buffer.alloc(2048)
  crashFixture().copy(bytes)
  bytes.writeUInt32LE(4, 8)
  bytes.writeUInt32LE(5, 68)
  bytes.writeUInt32LE(20, 72)
  bytes.writeUInt32LE(1100, 76)
  bytes.writeUInt32LE(256, 240)
  bytes.writeUInt32LE(1200, 244)
  bytes.writeUInt32LE(0x10_00_01, 1248)
  bytes.writeBigUInt64LE(0x10_10n, 1448)
  bytes.writeUInt32LE(1, 1100)
  bytes.writeBigUInt64LE(0x10_10n, 1104)
  bytes.writeUInt32LE(opcode.length, 1112)
  bytes.writeUInt32LE(1600, 1116)
  bytes.set(opcode, 1600)
  return bytes
}

test.each([
  ['ud2', [0x0f, 0x0b]],
  ['int3', [0xcc]],
  ['vex-prefix', [0xc5, 0xf8]],
  ['vex-prefix', [0xc4, 0xe2, 0x79]],
  ['evex-prefix', [0x62, 0xf1, 0x7c, 0x48]],
  ['other', [0x90]],
  ['unavailable', [0x0f]],
] as const)(
  'classifies instruction encoding %s without bytes or addresses',
  (encoding, opcode) => {
    const result = parseGemmaCrash(instructionFixture([...opcode]))
    expect(result).toMatchObject({
      instruction: {
        status: 'captured',
        encoding,
        moduleClassification: 'approved',
        module: 'liboptimization_guide_internal.so',
      },
    })
    expect(JSON.stringify(result)).not.toContain('4112')
  },
)

test('separates unknown modules from addresses outside module ranges', () => {
  const bytes = instructionFixture([0xcc])
  bytes.writeBigUInt64LE(0x30_00n, 1448)
  expect(parseGemmaCrash(bytes)).toMatchObject({
    instruction: { moduleClassification: 'no-match', encoding: 'unavailable' },
  })
  bytes.writeBigUInt64LE(0x10_10n, 1448)
  bytes.fill(0, 420, 600)
  bytes.writeUInt32LE(14, 420)
  bytes.write('private', 424, 'utf16le')
  expect(parseGemmaCrash(bytes)).toMatchObject({
    instruction: { moduleClassification: 'other' },
  })
  expect(JSON.stringify(parseGemmaCrash(bytes))).not.toContain('private')
})

test.each([
  ['context size', 240, 255],
  ['memory count', 1100, 4097],
  ['memory bounds', 1116, 2048],
  ['truncated memory list', 72, 19],
] as const)('rejects malformed instruction %s', (name, offset, value) => {
  expect(name.length).toBeGreaterThan(0)
  const bytes = instructionFixture([0xcc])
  bytes.writeUInt32LE(value, offset)
  expect(parseGemmaCrash(bytes)).toEqual({ status: 'unavailable' })
})

test('requires AMD64 control registers before reading RIP', () => {
  const bytes = instructionFixture([0xcc])
  bytes.writeUInt32LE(0x10_00_02, 1248)
  expect(parseGemmaCrash(bytes)).toMatchObject({
    instruction: { status: 'unavailable' },
  })
})

test('rejects ambiguous captured memory ranges', () => {
  const bytes = instructionFixture([0xcc])
  bytes.writeUInt32LE(36, 72)
  bytes.writeUInt32LE(2, 1100)
  bytes.copy(bytes, 1120, 1104, 1120)
  expect(parseGemmaCrash(bytes)).toEqual({ status: 'unavailable' })
})

test('extracts bounded instruction bytes without exposing unapproved module names in parsed output', () => {
  const bytes = instructionFixture([0x0f, 0xb9, 0xc0])
  const details = readGemmaCrashDetails(bytes)
  expect(details?.instructionBytes).toEqual(new Uint8Array([0x0f, 0xb9, 0xc0]))
  expect(details?.module).toBe('liboptimization_guide_internal.so')
  expect(details?.unwindStatus).toBe('unavailable')
  expect(readGemmaCrashDetails(crashFixture())).toBeUndefined()
})

test('extracts an ELF build identity from a bounded CodeView record', () => {
  const bytes = instructionFixture([0xcc])
  bytes.writeUInt32LE(8, 384)
  bytes.writeUInt32LE(1700, 388)
  bytes.writeUInt32LE(0x42_70_45_4c, 1700)
  bytes.set([1, 2, 3, 4], 1704)
  expect(readGemmaCrashDetails(bytes)?.moduleBuildId).toBe('01020304')
})
