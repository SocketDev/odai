import { Buffer } from 'node:buffer'
import { isPlainObject } from '@socketsecurity/lib-stable/objects/predicates'

const MAX_INPUT_BYTES = 1024 ** 2
const MAX_EVENTS = 32

export interface GemmaKernelFault {
  category: 'invalid-opcode' | 'seccomp' | 'segfault'
  module: 'chrome' | 'liboptimization_guide_internal.so' | 'on_device_model'
  timeSeconds: number
  signal?: number | undefined
  syscall?: number | undefined
}

export interface GemmaKernelFaults {
  status: 'captured' | 'unavailable'
  attribution: 'host-during-probe'
  events: GemmaKernelFault[]
  truncated?: boolean | undefined
}

function approvedModule(
  value: string | undefined,
): GemmaKernelFault['module'] | undefined {
  return value === 'chrome' ||
    value === 'liboptimization_guide_internal.so' ||
    value === 'on_device_model'
    ? value
    : undefined
}

function parseFault(
  message: string,
  timeSeconds: number,
): GemmaKernelFault | undefined {
  // Task and address fields validate the kernel shape but never leave the parser.
  const match =
    /^(?:traps: )?[^\]\r\n[]{1,64}\[\d{1,10}\]:? (?<detail>[^\r\n]{1,180}) in (?<module>[a-z_.]{1,40})\[[\da-f]{1,16}\+[\da-f]{1,16}\](?: likely on CPU \d{1,6} \(core \d{1,6}, socket \d{1,6}\))?$/.exec(
      message,
    )
  const module = approvedModule(match?.groups?.['module'])
  const detail = match?.groups?.['detail']
  if (!module || !detail) {
    return undefined
  }
  // The error field is a hardware error code, not a signal or trap number.
  if (
    /^trap invalid opcode ip:[\da-f]{1,16} sp:[\da-f]{1,16} error:[\da-f]{1,16}$/.test(
      detail,
    )
  ) {
    return { category: 'invalid-opcode', module, timeSeconds }
  }
  if (
    /^segfault at [\da-f]{1,16} ip [\da-f]{1,16} sp [\da-f]{1,16} error [\da-f]{1,16}$/.test(
      detail,
    )
  ) {
    return { category: 'segfault', module, timeSeconds }
  }
  return undefined
}

function parseSeccomp(
  message: string,
  timeSeconds: number,
): GemmaKernelFault | undefined {
  // AUDIT_SECCOMP is type 1326; its timestamp is not the monotonic record time.
  if (
    !/^audit: type=1326 audit\(\d{1,16}\.\d{1,9}:\d{1,16}\): /.test(message)
  ) {
    return undefined
  }
  // Ordered quoted fields prevent a task name or path from injecting numeric fields.
  const match =
    /(?:^| )comm="[^"\r\n]{0,64}" exe="\/(?:[^"\r\n]{0,1000}\/)?(?<module>chrome|on_device_model)" sig=(?<signal>\d{1,3}) arch=[\da-f]{1,16} syscall=(?<syscall>-?\d{1,10})(?: |$)/.exec(
      message,
    )
  const module = approvedModule(match?.groups?.['module'])
  if (!module) {
    return undefined
  }
  const signal = Number(match?.groups?.['signal'])
  const syscall = Number(match?.groups?.['syscall'])
  if (signal > 64 || syscall < -2_147_483_648 || syscall > 2_147_483_647) {
    return undefined
  }
  return { category: 'seccomp', module, timeSeconds, signal, syscall }
}

function readKernelRecord(
  record: unknown,
): { priority: number; time: number; message: string } | undefined {
  if (!isPlainObject(record)) {
    return undefined
  }
  const priority = record['pri']
  const time = record['time']
  const message = record['msg']
  if (
    typeof priority !== 'number' ||
    !Number.isSafeInteger(priority) ||
    priority < 0 ||
    typeof time !== 'number' ||
    !Number.isFinite(time) ||
    time < 0 ||
    typeof message !== 'string'
  ) {
    return undefined
  }
  return { priority, time, message }
}

export function parseGemmaKernelFaults(
  input: string,
  sinceSeconds: number,
): GemmaKernelFaults {
  const unavailable: GemmaKernelFaults = {
    status: 'unavailable',
    attribution: 'host-during-probe',
    events: [],
  }
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    return { ...unavailable, truncated: true }
  }
  if (!Number.isFinite(sinceSeconds) || sinceSeconds < 0) {
    return unavailable
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return unavailable
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed['dmesg'])) {
    return unavailable
  }
  const records: unknown[] = parsed['dmesg']
  const events: GemmaKernelFault[] = []
  let truncated = false
  for (let index = 0, count = records.length; index < count; index += 1) {
    const record = readKernelRecord(records[index])
    if (!record) {
      return unavailable
    }
    const { priority, time, message } = record
    if (priority > 7 || time <= sinceSeconds) {
      continue
    }
    const event = parseFault(message, time) ?? parseSeccomp(message, time)
    if (event) {
      if (events.length < MAX_EVENTS) {
        events.push(event)
      } else {
        truncated = true
      }
    }
  }
  return {
    status: 'captured',
    attribution: 'host-during-probe',
    events,
    ...(truncated ? { truncated: true } : {}),
  }
}
