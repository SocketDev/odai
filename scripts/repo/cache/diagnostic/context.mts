import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function readDiagnosticFile(
  file: string,
): Promise<string | { status: 'unavailable' }> {
  try {
    const handle = await fs.open(file, 'r')
    try {
      const buffer = Buffer.alloc(128 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    const unavailable = { __proto__: null, status: 'unavailable' as const }
    return unavailable
  }
}

export async function writeGemmaDiagnosticContext(config: {
  directory: string
  imageDigest: string
  result: unknown
  sourceRun: string
}): Promise<void> {
  const opts = { __proto__: null, ...config }
  const metadata = {
    schemaVersion: 1,
    imageDigest: opts.imageDigest,
    sourceRun: opts.sourceRun,
    capturedAt: new Date().toISOString(),
    architecture: os.arch(),
    platform: os.platform(),
    kernel: os.release(),
    availableParallelism: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    chromeVersion: await readDiagnosticFile('/opt/odai-cache/chrome-version'),
    decoder: await readDiagnosticFile('/opt/odai-cache/decoder-metadata.json'),
    imageModules: await readDiagnosticFile(
      '/opt/odai-cache/native-modules.json',
    ),
    cpu: await readDiagnosticFile('/proc/cpuinfo'),
    memory: await readDiagnosticFile('/proc/meminfo'),
    cgroup: await readDiagnosticFile('/proc/self/cgroup'),
    memoryLimit: await readDiagnosticFile('/sys/fs/cgroup/memory.max'),
    memoryPeak: await readDiagnosticFile('/sys/fs/cgroup/memory.peak'),
    memoryEvents: await readDiagnosticFile('/sys/fs/cgroup/memory.events'),
    cpuLimit: await readDiagnosticFile('/sys/fs/cgroup/cpu.max'),
    cpuAffinity: await readDiagnosticFile(
      '/sys/fs/cgroup/cpuset.cpus.effective',
    ),
    result: opts.result,
  }
  const text = JSON.stringify(metadata)
  if (Buffer.byteLength(text) > 512 * 1024) {
    throw new Error(
      'Gemma diagnostic context exceeds its private artifact limit',
    )
  }
  await fs.writeFile(path.join(opts.directory, 'metadata.json'), text, {
    flag: 'wx',
    mode: 0o600,
  })
}
