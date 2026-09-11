const MAX_BYTES = 16 * 1024 * 1024
const SIGNALS = new Set([4, 5, 6, 7, 8, 11, 31])
type CrashModule = 'chrome' | 'liboptimization_guide_internal.so'

type CrashEncoding =
  | 'ud2'
  | 'int3'
  | 'vex-prefix'
  | 'evex-prefix'
  | 'other'
  | 'unavailable'
type CrashInstruction =
  | { status: 'unavailable' }
  | {
      status: 'captured'
      encoding: CrashEncoding
      moduleClassification: 'approved' | 'other' | 'no-match'
      module?: CrashModule | undefined
    }

type CrashStream = { offset: number; size: number }
export type GemmaCrashDiagnostics =
  | { status: 'unavailable' }
  | {
      status: 'captured'
      instruction: CrashInstruction
      exceptionCode: number
      exceptionFlags: number
      signal?: number | undefined
      exceptionModule?: CrashModule | undefined
    }

function checkRange(view: DataView, offset: number, size: number): void {
  if (offset < 0 || size < 0 || offset > view.byteLength - size) {
    throw new RangeError('Invalid minidump range')
  }
}

function crashStreams(view: DataView): Map<number, CrashStream> {
  checkRange(view, 0, 32)
  if (
    view.getUint32(0, true) !== 0x50_4d_44_4d ||
    (view.getUint32(4, true) & 0xff_ff) !== 0xa7_93
  ) {
    throw new RangeError('Invalid minidump header')
  }
  const count = view.getUint32(8, true)
  const offset = view.getUint32(12, true)
  if (count > 128 || offset < 32) {
    throw new RangeError('Invalid minidump directory')
  }
  checkRange(view, offset, count * 12)
  const result = new Map<number, CrashStream>()
  for (let index = 0; index < count; index += 1) {
    const row = offset + index * 12
    const type = view.getUint32(row, true)
    const size = view.getUint32(row + 4, true)
    const start = view.getUint32(row + 8, true)
    if (result.has(type) || (size > 0 && start < offset + count * 12)) {
      throw new RangeError('Invalid minidump stream')
    }
    checkRange(view, start, size)
    for (const previous of result.values()) {
      if (
        size > 0 &&
        previous.size > 0 &&
        start < previous.offset + previous.size &&
        previous.offset < start + size
      ) {
        throw new RangeError('Overlapping minidump streams')
      }
    }
    result.set(type, { offset: start, size })
  }
  return result
}

function crashString(view: DataView, offset: number): string {
  checkRange(view, offset, 4)
  const size = view.getUint32(offset, true)
  if (size > 1024 || size % 2 !== 0) {
    throw new RangeError('Invalid minidump string')
  }
  checkRange(view, offset + 4, size + 2)
  if (view.getUint16(offset + 4 + size, true) !== 0) {
    throw new RangeError('Invalid minidump string terminator')
  }
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset + 4, size)
  return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
}

function crashModule(
  view: DataView,
  stream: CrashStream,
  address: bigint,
): {
  classification: 'approved' | 'other' | 'no-match'
  module?: CrashModule | undefined
} {
  if (stream.size < 4) {
    throw new RangeError('Invalid minidump modules')
  }
  const count = view.getUint32(stream.offset, true)
  if (count > 512 || stream.size < 4 + count * 108) {
    throw new RangeError('Invalid minidump modules')
  }
  let found: CrashModule | undefined
  let matched = false
  for (let index = 0; index < count; index += 1) {
    const row = stream.offset + 4 + index * 108
    const base = view.getBigUint64(row, true)
    const end = base + BigInt(view.getUint32(row + 8, true))
    if (end > 0x1_00_00_00_00_00_00_00_00n) {
      throw new RangeError('Invalid minidump module range')
    }
    const name = crashString(view, view.getUint32(row + 20, true))
    checkRange(
      view,
      view.getUint32(row + 80, true),
      view.getUint32(row + 76, true),
    )
    checkRange(
      view,
      view.getUint32(row + 88, true),
      view.getUint32(row + 84, true),
    )
    if (address >= base && address < end) {
      if (matched) {
        throw new RangeError('Ambiguous minidump module')
      }
      matched = true
      const basename = name.slice(name.lastIndexOf('/') + 1)
      if (
        basename === 'chrome' ||
        basename === 'liboptimization_guide_internal.so'
      ) {
        found = basename
      }
    }
  }
  const result = {
    __proto__: null,
    classification: found
      ? ('approved' as const)
      : matched
        ? ('other' as const)
        : ('no-match' as const),
    ...(found ? { module: found } : {}),
  }
  return result
}

function instructionEncoding(
  view: DataView,
  offset: number,
  size: number,
): CrashEncoding {
  const first = view.getUint8(offset)
  if (first === 0xcc) {
    return 'int3'
  }
  if (first === 0x0f) {
    return size < 2
      ? 'unavailable'
      : view.getUint8(offset + 1) === 0x0b
        ? 'ud2'
        : 'other'
  }
  if (first === 0xc5) {
    return size < 2 ? 'unavailable' : 'vex-prefix'
  }
  if (first === 0xc4) {
    return size < 3 ? 'unavailable' : 'vex-prefix'
  }
  if (first === 0x62) {
    return size < 4 ? 'unavailable' : 'evex-prefix'
  }
  return 'other'
}

function memoryEncoding(
  view: DataView,
  stream: CrashStream | undefined,
  address: bigint,
): CrashEncoding {
  if (!stream) {
    return 'unavailable'
  }
  if (stream.size < 4) {
    throw new RangeError('Invalid minidump memory list')
  }
  const count = view.getUint32(stream.offset, true)
  if (count > 4096 || stream.size < 4 + count * 16) {
    throw new RangeError('Invalid minidump memory count')
  }
  let found: CrashEncoding = 'unavailable'
  let matched = false
  for (let index = 0; index < count; index += 1) {
    const row = stream.offset + 4 + index * 16
    const base = view.getBigUint64(row, true)
    const size = view.getUint32(row + 8, true)
    const offset = view.getUint32(row + 12, true)
    checkRange(view, offset, size)
    const end = base + BigInt(size)
    if (end > 0x1_00_00_00_00_00_00_00_00n) {
      throw new RangeError('Invalid minidump memory range')
    }
    if (address >= base && address < end) {
      if (matched) {
        throw new RangeError('Ambiguous minidump instruction memory')
      }
      matched = true
      const distance = Number(address - base)
      found = instructionEncoding(view, offset + distance, size - distance)
    }
  }
  return found
}

function crashInstruction(
  view: DataView,
  streams: Map<number, CrashStream>,
  context: CrashStream,
): CrashInstruction {
  if (context.size === 0) {
    return { status: 'unavailable' }
  }
  if (context.size < 256) {
    throw new RangeError('Truncated minidump AMD64 context')
  }
  if ((view.getUint32(context.offset + 48, true) & 0x10_00_01) !== 0x10_00_01) {
    return { status: 'unavailable' }
  }
  const address = view.getBigUint64(context.offset + 248, true)
  const module = crashModule(view, streams.get(4)!, address)
  const result = {
    __proto__: null,
    status: 'captured' as const,
    encoding: memoryEncoding(view, streams.get(5), address),
    moduleClassification: module.classification,
    ...(module.module ? { module: module.module } : {}),
  }
  return result
}

export function parseGemmaCrash(input: Uint8Array): GemmaCrashDiagnostics {
  try {
    if (input.byteLength > MAX_BYTES) {
      return { status: 'unavailable' }
    }
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    const streams = crashStreams(view)
    const exception = streams.get(6)
    const system = streams.get(7)
    const modules = streams.get(4)
    if (
      !exception ||
      exception.size < 168 ||
      !system ||
      system.size < 56 ||
      !modules
    ) {
      return { status: 'unavailable' }
    }
    const systemVersion = view.getUint32(system.offset + 24, true)
    if (systemVersion !== 0) {
      crashString(view, systemVersion)
    }
    const offset = exception.offset
    if (view.getUint32(offset + 32, true) > 15) {
      return { status: 'unavailable' }
    }
    checkRange(
      view,
      view.getUint32(offset + 164, true),
      view.getUint32(offset + 160, true),
    )
    const exceptionCode = view.getUint32(offset + 8, true)
    const exceptionFlags = view.getUint32(offset + 12, true)
    const exceptionModule = crashModule(
      view,
      modules,
      view.getBigUint64(offset + 24, true),
    )
    const linuxX64 =
      view.getUint32(system.offset + 20, true) === 0x82_01 &&
      view.getUint16(system.offset, true) === 9
    const result = {
      __proto__: null,
      status: 'captured' as const,
      exceptionCode,
      exceptionFlags,
      ...(linuxX64 && SIGNALS.has(exceptionCode)
        ? { signal: exceptionCode }
        : {}),
      instruction: linuxX64
        ? crashInstruction(view, streams, {
            offset: view.getUint32(offset + 164, true),
            size: view.getUint32(offset + 160, true),
          })
        : { status: 'unavailable' as const },
      ...(exceptionModule.module
        ? { exceptionModule: exceptionModule.module }
        : {}),
    }
    return result
  } catch {
    return { status: 'unavailable' }
  }
}

export interface GemmaCrashDetails {
  instructionBytes: Uint8Array
  module: string
  moduleName: string
  moduleBuildId?: string | undefined
  callChain: Array<{
    module: string
    moduleName: string
    buildId?: string | undefined
  }>
  unwindStatus: 'frame-pointers' | 'unavailable' | 'limited'
}

function detailedModule(
  view: DataView,
  stream: CrashStream,
  address: bigint,
): { module: string; moduleName: string; buildId?: string | undefined } {
  const approved = new Set([
    'chrome',
    'ld-linux-x86-64.so.2',
    'libc.so.6',
    'libgcc_s.so.1',
    'libm.so.6',
    'liboptimization_guide_internal.so',
    'libpthread.so.0',
    'libstdc++.so.6',
  ])
  for (let index = 0; index < view.getUint32(stream.offset, true); index += 1) {
    const row = stream.offset + 4 + index * 108
    const base = view.getBigUint64(row, true)
    if (
      address < base ||
      address >= base + BigInt(view.getUint32(row + 8, true))
    ) {
      continue
    }
    const name = crashString(view, view.getUint32(row + 20, true))
    const basename = name.slice(name.lastIndexOf('/') + 1)
    const size = view.getUint32(row + 76, true)
    const offset = view.getUint32(row + 80, true)
    let buildId: string | undefined
    if (
      size >= 5 &&
      size <= 68 &&
      view.getUint32(offset, true) === 0x42_70_45_4c
    ) {
      buildId = Array.from(
        new Uint8Array(view.buffer, view.byteOffset + offset + 4, size - 4),
        byte => byte.toString(16).padStart(2, '0'),
      ).join('')
    }
    const result = {
      __proto__: null,
      module: approved.has(basename) ? basename : 'other',
      moduleName: basename,
      ...(buildId ? { buildId } : {}),
    }
    return result
  }
  return { module: 'no-match', moduleName: '' }
}

function memoryBytes(
  view: DataView,
  stream: CrashStream,
  address: bigint,
  limit: number,
): Uint8Array {
  let result: Uint8Array = new Uint8Array()
  let matched = false
  const count = view.getUint32(stream.offset, true)
  for (let index = 0; index < count; index += 1) {
    const row = stream.offset + 4 + index * 16
    const base = view.getBigUint64(row, true)
    const size = view.getUint32(row + 8, true)
    if (address < base || address >= base + BigInt(size)) {
      continue
    }
    if (matched) {
      throw new RangeError('Ambiguous memory')
    }
    matched = true
    const distance = Number(address - base)
    result = new Uint8Array(
      view.buffer,
      view.byteOffset + view.getUint32(row + 12, true) + distance,
      Math.min(limit, size - distance),
    )
  }
  return result
}

export function readGemmaCrashDetails(
  input: Uint8Array,
): GemmaCrashDetails | undefined {
  const parsed = parseGemmaCrash(input)
  if (
    parsed.status !== 'captured' ||
    parsed.instruction.status !== 'captured'
  ) {
    return undefined
  }
  try {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    const streams = crashStreams(view)
    const memory = streams.get(5)
    if (!memory) {
      return undefined
    }
    const exception = streams.get(6)!
    const context = view.getUint32(exception.offset + 164, true)
    const address = view.getBigUint64(context + 248, true)
    const modules = streams.get(4)!
    const identity = detailedModule(view, modules, address)
    const instructionBytes = memoryBytes(view, memory, address, 15)
    const callChain = [identity]
    let frame = view.getBigUint64(context + 160, true)
    let unwindStatus: GemmaCrashDetails['unwindStatus'] = 'unavailable'
    if ((view.getUint32(context + 48, true) & 0x10_00_02) === 0x10_00_02) {
      for (let index = 0; index < 16 && frame !== 0n; index += 1) {
        const bytes = memoryBytes(view, memory, frame, 16)
        if (bytes.length !== 16) {
          break
        }
        const record = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        )
        const next = record.getBigUint64(0, true)
        const returnAddress = record.getBigUint64(8, true)
        if (
          next <= frame ||
          next - frame > 1024n * 1024n ||
          returnAddress === 0n
        ) {
          break
        }
        callChain.push(detailedModule(view, modules, returnAddress - 1n))
        frame = next
        unwindStatus = 'frame-pointers'
      }
      if (callChain.length === 17) {
        unwindStatus = 'limited'
      }
    }
    const result = {
      __proto__: null,
      instructionBytes,
      module: identity.module,
      moduleName: identity.moduleName,
      ...(identity.buildId ? { moduleBuildId: identity.buildId } : {}),
      callChain,
      unwindStatus,
    }
    return result
  } catch {
    return undefined
  }
}
