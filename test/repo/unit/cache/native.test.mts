import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import { afterEach, expect, test, vi } from 'vitest'
import { createGemmaNativeDiagnostics } from '../../../../scripts/repo/cache/native.mts'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'

test('captures native failure categories without returning private log text', async () => {
  const collector = await createGemmaNativeDiagnostics()
  try {
    expect(collector.logFile).toBeTypeOf('string')
    await fs.appendFile(
      collector.logFile!,
      '[123:456:ERROR:service_client.cc:37] Unexpected on_device_model service disconnect; reason: 2, description: private-value\n[123:456:ERROR:on_device_model_executor.cc:836] SessionCreateModel failed.\n',
    )
    const result = await collector.read()
    expect(result.log).toMatchObject({
      status: 'captured',
      events: [
        { category: 'service-disconnect', reason: 2 },
        { category: 'model-creation-failed' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('private-value')
  } finally {
    await collector.close()
  }
  expect(existsSync(collector.logFile!)).toBe(false)
})

test('distinguishes an empty capture from unavailable logging and caps retained output', async () => {
  const collector = await createGemmaNativeDiagnostics()
  try {
    expect((await collector.read()).log).toEqual({
      status: 'captured',
      events: [],
      truncated: false,
    })
    const line =
      '[123:456:ERROR:chrome_ml.cc:101] Terminating On-Device Model Service: Out of memory private-value\n'
    await fs.appendFile(collector.logFile!, line.repeat(1000))
    const result = await collector.read()
    expect(result.log.events).toHaveLength(64)
    expect(result.log.events[0]).toEqual({
      category: 'native-fatal',
      token: 'Out of memory',
    })
    expect(result.log.truncated).toBe(true)
    expect((await fs.stat(collector.logFile!)).size).toBeGreaterThan(0)
    await safeDelete(collector.logFile!)
    expect((await collector.read()).log.status).toBe('unavailable')
  } finally {
    await collector.close()
  }
})

test('ignores unrelated sources and malformed reason values', async () => {
  const collector = await createGemmaNativeDiagnostics()
  try {
    await fs.appendFile(
      collector.logFile!,
      [
        '[123:456:ERROR:other.cc:1] SessionCreateModel failed.',
        '[123:456:INFO:on_device_model_executor.cc:836] SessionCreateModel failed.',
        '[123:456:ERROR:service_client.cc:37] Unexpected on_device_model service disconnect; reason: bad, description: private-value',
        "[123:456:ERROR:chrome_ml.cc:98] Failed to initialize Dawn's proc tables.",
        '[123:456:FATAL:chrome_ml.cc:108] ChromeML Error: private-value',
        '[123:456:ERROR:manifest_solution_factory.cc:804] Base model disconnected unexpectedly; reason: 0, description: private-value',
        '[123:456:ERROR:on_device_model_executor.cc:768] GPU blocked for on-device model. Reason: 3',
      ].join('\n') + '\n',
    )
    expect((await collector.read()).log.events).toEqual([
      { category: 'dawn-initialization-failed' },
      { category: 'native-fatal' },
      { category: 'model-disconnect', reason: 0 },
      { category: 'gpu-blocked', reason: 3 },
    ])
  } finally {
    await collector.close()
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('reports cgroup counter deltas and current limits without exposing paths', async () => {
  vi.spyOn(os, 'platform').mockReturnValue('linux')
  const open = fs.open.bind(fs)
  let later = false
  const files: Record<string, string> = {
    '/proc/self/cgroup': '0::/probe\n',
    '/proc/self/mountinfo':
      '42 1 0:28 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
    '/sys/fs/cgroup/probe/memory.current': '2048',
    '/sys/fs/cgroup/probe/memory.peak': '4096',
    '/sys/fs/cgroup/probe/memory.max': 'max',
  }
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const name = String(file)
    const content =
      name === '/sys/fs/cgroup/probe/memory.events'
        ? later
          ? 'high 3\nmax 0\noom 1\noom_kill 1\n'
          : 'high 1\nmax 0\noom 0\noom_kill 0\n'
        : files[name]
    if (content === undefined) {
      return open(file, flags, mode)
    }
    const temporary = await open(new URL(import.meta.url), 'r')
    vi.spyOn(temporary, 'read').mockImplementation(async options => {
      const buffer = Buffer.isBuffer(options) ? options : options?.buffer
      if (!buffer) {
        throw new Error('The mocked read requires a destination buffer')
      }
      const target = Buffer.from(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      )
      const bytesRead = target.write(content)
      return { bytesRead, buffer }
    })
    return temporary
  })
  const collector = await createGemmaNativeDiagnostics()
  try {
    later = true
    expect((await collector.read()).memory).toEqual({
      status: 'captured',
      events: { high: 2, max: 0, oom: 1, oom_kill: 1 },
      currentBytes: 2048,
      peakBytes: 4096,
      maxBytes: 'max',
    })
  } finally {
    await collector.close()
  }
})

test('keeps instrumentation failure nonfatal', async () => {
  vi.spyOn(os, 'platform').mockReturnValue('darwin')
  vi.spyOn(fs, 'mkdtemp').mockRejectedValue(new Error('unavailable'))
  const collector = await createGemmaNativeDiagnostics()
  expect(collector.logFile).toBeUndefined()
  expect(await collector.read()).toEqual({
    log: { status: 'unavailable', events: [], truncated: false },
    memory: { status: 'unavailable' },
  })
  await collector.close()
})

test('drains at close and retains only sanitized final events', async () => {
  const collector = await createGemmaNativeDiagnostics()
  await fs.appendFile(
    collector.logFile!,
    '[123:456:ERROR:on_device_model_executor.cc:836] SessionCreateModel failed.\n',
  )
  await collector.close()
  expect((await collector.read()).log.events).toEqual([
    { category: 'model-creation-failed' },
  ])
  expect(existsSync(collector.logFile!)).toBe(false)
  await collector.close()
})

test('periodically drains the raw log between explicit reads', async () => {
  vi.useFakeTimers()
  const collector = await createGemmaNativeDiagnostics()
  try {
    await fs.appendFile(
      collector.logFile!,
      '[123:456:ERROR:on_device_model_executor.cc:836] SessionCreateModel failed.\n',
    )
    await vi.advanceTimersByTimeAsync(250)
    const result = await collector.read()
    expect(result.log.events).toEqual([{ category: 'model-creation-failed' }])
    expect((await fs.stat(collector.logFile!)).size).toBeGreaterThan(0)
  } finally {
    await collector.close()
    vi.useRealTimers()
  }
})

test('retains partial lines and later appends without deleting writer bytes', async () => {
  const collector = await createGemmaNativeDiagnostics()
  try {
    const prefix =
      '[123:456:ERROR:service_client.cc:37] Unexpected on_device_model service disconnect; reason: '
    await fs.appendFile(collector.logFile!, prefix)
    expect((await collector.read()).log.events).toEqual([])
    await fs.appendFile(collector.logFile!, '2, description: private-value\n')
    expect((await collector.read()).log.events).toEqual([
      { category: 'service-disconnect', reason: 2 },
    ])
    expect(await fs.readFile(collector.logFile!, 'utf8')).toBe(
      prefix + '2, description: private-value\n',
    )
  } finally {
    await collector.close()
  }
})

test('keeps decisive tail events and invokes the limit callback once', async () => {
  const onLimit = vi.fn<() => void>()
  const collector = await createGemmaNativeDiagnostics({ onLimit })
  try {
    const line =
      '[123:456:ERROR:service_client.cc:37] Unexpected on_device_model service disconnect; reason: 0\n'
    await fs.appendFile(collector.logFile!, line.repeat(100))
    await fs.appendFile(collector.logFile!, 'unknown\n'.repeat(140_000))
    await fs.appendFile(
      collector.logFile!,
      '[123:456:ERROR:on_device_model_executor.cc:836] SessionCreateModel failed.\n',
    )
    const result = await collector.read()
    expect(result.log.events).toHaveLength(64)
    expect(result.log.events.at(-1)).toEqual({
      category: 'model-creation-failed',
    })
    expect(result.log.events.slice(0, 16)).toEqual(
      Array.from({ length: 16 }, () => ({
        category: 'service-disconnect',
        reason: 0,
      })),
    )
    expect(onLimit).toHaveBeenCalledTimes(1)
    expect(result.log.truncated).toBe(true)
  } finally {
    await collector.close()
  }
})

test('does not start acquisition after the setup deadline', async () => {
  const create = vi.spyOn(fs, 'mkdtemp')
  const collector = await createGemmaNativeDiagnostics({ timeoutMs: 0 })
  expect(collector.logFile).toBeUndefined()
  expect(create).not.toHaveBeenCalled()
  await collector.close()
})

test('preserves concurrent appends and serializes overlapping reads', async () => {
  const collector = await createGemmaNativeDiagnostics()
  try {
    const line =
      '[123:456:ERROR:on_device_model_executor.cc:836] SessionCreateModel failed.\n'
    await fs.appendFile(collector.logFile!, line)
    const results = await Promise.allSettled([
      collector.read(),
      fs.appendFile(collector.logFile!, line),
      collector.read(),
    ])
    for (const result of results) {
      expect(result.status).toBe('fulfilled')
    }
    expect((await collector.read()).log.events).toEqual([
      { category: 'model-creation-failed' },
      { category: 'model-creation-failed' },
    ])
    expect(await fs.readFile(collector.logFile!, 'utf8')).toBe(line.repeat(2))
  } finally {
    await collector.close()
  }
})

test('recognizes the pinned Chrome colon line-number log format', async () => {
  const collector = await createGemmaNativeDiagnostics()
  try {
    await fs.appendFile(
      collector.logFile!,
      '[8:34:0910/211704.231841:ERROR:services/on_device_model/public/cpp/service_client.cc:37] Unexpected on_device_model service disconnect; reason: 2, description: private-value\n',
    )
    expect((await collector.read()).log.events).toEqual([
      { category: 'service-disconnect', reason: 2 },
    ])
  } finally {
    await collector.close()
  }
})

test('rejects relative diagnostic roots before creating files', async () => {
  const create = vi.spyOn(fs, 'mkdtemp')
  const collector = await createGemmaNativeDiagnostics({
    root: 'relative-diagnostics',
  })
  try {
    expect(create).not.toHaveBeenCalled()
    expect(collector.logFile).toBeUndefined()
    expect((await collector.read()).log.status).toBe('unavailable')
  } finally {
    await collector.close()
  }
})

test('preserves raw logs only through an explicit option', async () => {
  const root = await fs.mkdtemp(`${os.tmpdir()}/gemma-preserve-`)
  const collector = await createGemmaNativeDiagnostics({ root, preserve: true })
  try {
    expect(collector.logFile).toBeTypeOf('string')
    await fs.appendFile(collector.logFile!, 'example raw diagnostic\n')
    await collector.close()
    expect(await fs.readFile(collector.logFile!, 'utf8')).toBe(
      'example raw diagnostic\n',
    )
  } finally {
    await collector.close()
    await safeDelete(root)
  }
})
