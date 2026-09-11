import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'

const MAX_BYTES = 64 * 1024
const MAX_EVENTS = 64
const MAX_LOG_BYTES = 1024 * 1024
const MEMORY_KEYS = ['high', 'max', 'oom', 'oom_kill', 'oom_group_kill']
const ERROR_TOKENS = [
  'DXGI_ERROR_DEVICE_HUNG',
  'DXGI_ERROR_DEVICE_REMOVED',
  'VK_ERROR_DEVICE_LOST',
  'VK_ERROR_OUT_OF_DEVICE_MEMORY',
  'E_OUTOFMEMORY',
  'VirtualAlloc 1455',
  'Out of memory',
  'Failed to create device',
]

type NativeEvent = {
  category: string
  reason?: number | undefined
  token?: string | undefined
}
type MemorySnapshot = {
  events: Record<string, number>
  currentBytes?: number | undefined
  peakBytes?: number | undefined
  maxBytes?: number | 'max' | undefined
}
export interface GemmaNativeDiagnostics {
  log: {
    status: 'captured' | 'unavailable'
    events: NativeEvent[]
    truncated: boolean
  }
  memory: { status: 'unavailable' } | ({ status: 'captured' } & MemorySnapshot)
}

async function readLimited(file: string): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(MAX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

function nativeEvent(line: string): NativeEvent | undefined {
  const match =
    /^\[[^\]\r\n]{1,200}:(?:ERROR|FATAL):(?:[^\]\r\n]*\/)?(?<source>[a-z_]+\.cc):\d+\]\s*(?<message>.*)$/.exec(
      line,
    )
  const source = match?.groups?.['source']
  const message = match?.groups?.['message']
  if (!message) {
    return undefined
  }
  const prefixes = [
    [
      'service_client.cc',
      'Unexpected on_device_model service disconnect; reason: ',
      'service-disconnect',
    ],
    [
      'manifest_solution_factory.cc',
      'Base model disconnected unexpectedly; reason: ',
      'model-disconnect',
    ],
    [
      'on_device_model_executor.cc',
      'GPU blocked for on-device model. Reason: ',
      'gpu-blocked',
    ],
  ]
  for (const [file, prefix, category] of prefixes) {
    if (source === file && message.startsWith(prefix!)) {
      // The bounded reason ends before a description or at the line ending.
      const number = /^(\d{1,10})(?:,|$)/.exec(
        message.slice(prefix!.length),
      )?.[1]
      if (number) {
        return { category: category!, reason: Number(number) }
      }
    }
  }
  if (
    source === 'on_device_model_executor.cc' &&
    message === 'SessionCreateModel failed.'
  ) {
    return { category: 'model-creation-failed' }
  }
  return source === 'chrome_ml.cc' ? nativeFatalEvent(message) : undefined
}

function nativeFatalEvent(message: string): NativeEvent | undefined {
  if (message === "Failed to initialize Dawn's proc tables.") {
    return { category: 'dawn-initialization-failed' }
  }
  const fatal = [
    'Terminating On-Device Model Service:',
    'ChromeML(GPU) Error:',
    'ChromeML Error:',
  ].some(prefix => message.startsWith(prefix))
  if (!fatal) {
    return undefined
  }
  const token = ERROR_TOKENS.find(value => message.includes(value))
  return { category: 'native-fatal', ...(token ? { token } : {}) }
}

async function memoryDirectory(): Promise<string | undefined> {
  if (os.platform() !== 'linux') {
    return undefined
  }
  const membership = /^0::([^\n]+)$/m.exec(
    await readLimited('/proc/self/cgroup'),
  )?.[1]
  if (!membership || membership.includes('..')) {
    return undefined
  }
  const rows = (await readLimited('/proc/self/mountinfo')).split(/\r?\n/)
  const mount = rows.find(row => row.includes(' - cgroup2 '))?.split(' ')
  if (
    !mount?.[3] ||
    !mount[4] ||
    mount[3].includes('\\') ||
    mount[4].includes('\\')
  ) {
    return undefined
  }
  const relative = path.posix.relative(mount[3], membership)
  if (relative.startsWith('..')) {
    return undefined
  }
  return path.join(mount[4], relative)
}

function numericMemory(text: string): number | undefined {
  const trimmed = text.trim()
  const number = Number(trimmed)
  return /^\d+$/.test(trimmed) && Number.isSafeInteger(number)
    ? number
    : undefined
}

async function memorySnapshot(
  directory: string,
): Promise<MemorySnapshot | undefined> {
  try {
    const events: Record<string, number> = {}
    const rows = (
      await readLimited(path.join(directory, 'memory.events'))
    ).split(/\r?\n/)
    for (let i = 0, { length } = rows; i < length; i += 1) {
      const row = rows[i]!
      const { 0: key, 1: value } = row.split(' ')
      const number = numericMemory(value ?? '')
      if (key && MEMORY_KEYS.includes(key) && number !== undefined) {
        events[key] = number
      }
    }
    if (!Object.keys(events).length) {
      return undefined
    }
    const result: MemorySnapshot = { events }
    for (const [name, key] of [
      ['memory.current', 'currentBytes'],
      ['memory.peak', 'peakBytes'],
      ['memory.max', 'maxBytes'],
    ] as const) {
      try {
        const text = await readLimited(path.join(directory, name))
        if (key === 'maxBytes' && text.trim() === 'max') {
          result.maxBytes = 'max'
        } else {
          const number = numericMemory(text)
          if (number !== undefined) {
            result[key] = number
          }
        }
      } catch {}
    }
    return result
  } catch {
    return undefined
  }
}

async function boundedCapture<T>(
  operation: () => Promise<T>,
  fallback: T,
  deadline = Date.now() + 1500,
): Promise<T> {
  return new Promise(resolve => {
    if (Date.now() >= deadline) {
      resolve(fallback)
      return
    }
    const timer = setTimeout(
      () => resolve(fallback),
      Math.max(0, deadline - Date.now()),
    )
    operation().then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

export async function createGemmaNativeDiagnostics(
  options: {
    root?: string | undefined
    timeoutMs?: number | undefined
    onLimit?: (() => void) | undefined
    preserve?: boolean | undefined
  } = {},
): Promise<{
  logFile?: string | undefined
  read(): Promise<GemmaNativeDiagnostics>
  close(): Promise<void>
}> {
  const setupDeadline =
    Date.now() + Math.max(0, Math.min(options.timeoutMs ?? 1500, 1500))
  let offset = 0
  let pending = ''
  let skippingLine = false
  let notified = false
  let directory: string | undefined
  let logFile: string | undefined
  let logAvailable = false
  let truncated = false
  let closed = false
  const events: NativeEvent[] = []
  let draining: Promise<void> | undefined
  const memoryRoot = await boundedCapture(
    memoryDirectory,
    undefined,
    setupDeadline,
  )
  const before = memoryRoot
    ? await boundedCapture(
        () => memorySnapshot(memoryRoot),
        undefined,
        setupDeadline,
      )
    : undefined
  let setupExpired = false
  await boundedCapture(
    async () => {
      if (options.root !== undefined && !path.isAbsolute(options.root)) {
        return
      }
      const temporary = await fs.mkdtemp(
        path.join(options.root ?? os.tmpdir(), 'gemma-native-'),
      )
      try {
        await fs.chmod(temporary, 0o700)
        const file = path.join(temporary, 'chrome.log')
        await fs.writeFile(file, '', { mode: 0o600 })
        if (setupExpired) {
          await safeDelete(temporary)
          return
        }
        directory = temporary
        logFile = file
        logAvailable = true
      } catch {
        await safeDelete(temporary)
      }
    },
    undefined,
    setupDeadline,
  )
  setupExpired = true
  function consume(text: string): void {
    const lines = (pending + text).split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (let index = 0, count = lines.length; index < count; index += 1) {
      const line = lines[index]!
      if (skippingLine) {
        skippingLine = false
        continue
      }
      const event = nativeEvent(line)
      if (event) {
        if (events.length === MAX_EVENTS) {
          events.splice(16, 1)
          truncated = true
        }
        events.push(event)
      }
    }
    if (pending.length > MAX_BYTES) {
      pending = ''
      skippingLine = true
      truncated = true
    }
  }
  async function readChunk(tail = false): Promise<number> {
    if (closed || !logFile) {
      return 0
    }
    try {
      const handle = await fs.open(logFile, 'r')
      try {
        const size = (await handle.stat()).size
        if (size >= MAX_LOG_BYTES && !notified) {
          notified = true
          truncated = true
          try {
            options.onLimit?.()
          } catch {}
        }
        if (size < offset) {
          offset = 0
          pending = ''
          skippingLine = false
          truncated = true
        }
        if (tail && size - offset > MAX_BYTES) {
          offset = size - MAX_BYTES
          pending = ''
          skippingLine = true
          truncated = true
        }
        const buffer = Buffer.alloc(MAX_BYTES)
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          offset,
        )
        offset += bytesRead
        logAvailable = true
        consume(buffer.toString('utf8', 0, bytesRead))
        return bytesRead
      } finally {
        await handle.close()
      }
    } catch {
      logAvailable = false
      return 0
    }
  }
  async function drain(final = false): Promise<void> {
    if (draining && !final) {
      return draining
    }
    const previous = draining
    const operation = (async () => {
      await previous
      for (let index = 0, limit = final ? 17 : 1; index < limit; index += 1) {
        if ((await readChunk()) === 0) {
          break
        }
      }
      if (final) {
        await readChunk(true)
      }
    })().finally(() => {
      if (draining === operation) {
        draining = undefined
      }
    })
    draining = operation
    return operation
  }
  async function finalDrain(): Promise<void> {
    await drain(true)
  }
  const interval = setInterval(() => {
    void drain()
  }, 250)
  interval.unref()
  const collector = {
    __proto__: null,
    ...(logAvailable ? { logFile } : {}),
    async read(): Promise<GemmaNativeDiagnostics> {
      const deadline = Date.now() + 1500
      const completed = await boundedCapture(
        async () => {
          await finalDrain()
          return true
        },
        false,
        deadline,
      )
      if (!completed) {
        logAvailable = false
        truncated = true
      }
      const current =
        memoryRoot && before
          ? await boundedCapture(
              () => memorySnapshot(memoryRoot),
              undefined,
              deadline,
            )
          : undefined
      const memory: GemmaNativeDiagnostics['memory'] = { status: 'unavailable' }
      if (current && before) {
        const keys = Object.keys(current.events)
        for (let i = 0, { length } = keys; i < length; i += 1) {
          const key = keys[i]!
          const baseline = before.events[key]
          if (baseline === undefined || current.events[key]! < baseline) {
            delete current.events[key]
          } else {
            current.events[key] = current.events[key]! - baseline
          }
        }
        const result = {
          __proto__: null,
          log: {
            status: logAvailable
              ? ('captured' as const)
              : ('unavailable' as const),
            events: [...events],
            truncated,
          },
          memory: { status: 'captured' as const, ...current },
        }
        return result
      }
      const result = {
        __proto__: null,
        log: {
          status: logAvailable
            ? ('captured' as const)
            : ('unavailable' as const),
          events: [...events],
          truncated,
        },
        memory,
      }
      return result
    },
    async close() {
      clearInterval(interval)
      await boundedCapture(finalDrain, undefined)
      closed = true
      if (directory && !options.preserve) {
        await boundedCapture(
          () => safeDelete(directory!),
          undefined,
          Date.now() + 500,
        )
      }
    },
  }
  return collector
}
