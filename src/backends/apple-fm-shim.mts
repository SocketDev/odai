/**
 * @file Node-only machinery for the Apple Foundation Models backend: the
 *   Swift shim source, the compile-and-cache step, and the line-delimited
 *   JSON client that drives a spawned shim process. `apple-fm.mts` loads this
 *   module lazily after its runtime guard, so browser bundles never touch
 *   Node built-ins.
 */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'

import { errorMessage } from '@socketsecurity/lib/errors/message'
import { spawn } from '@socketsecurity/lib/process/spawn/child'

import type { Message, SessionLike } from '../types.mts'

const execFileAsync = promisify(execFile)

const COMPILE_TIMEOUT_MS = 300_000
const CREATE_TIMEOUT_MS = 10_000
const PROMPT_TIMEOUT_MS = 120_000
const REPLY_PREVIEW_MAX_LENGTH = 200
const STDERR_TAIL_MAX_LENGTH = 2048

/**
 * The Swift shim bridging the macOS 26+ FoundationModels framework to a
 * line-delimited JSON stdio protocol: one request object per stdin line, one
 * reply object per stdout line. Ops: `availability`, `create`, `prompt`,
 * `destroy`. Held as `String.raw` so Swift's `\"` and `\(op)` escapes survive
 * embedding.
 */
export const APPLE_FM_SHIM_SOURCE = String.raw`// Apple Foundation Models stdio shim. Speaks line-delimited JSON:
// one request object per stdin line, one reply object per stdout line.
// Ops: availability, create, prompt, destroy.

import Foundation
import FoundationModels

func writeReply(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
    FileHandle.standardOutput.write(Data("{\"ok\":false,\"error\":\"reply serialization failed\"}\n".utf8))
    return
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

func availabilityReply() -> [String: Any] {
  let availability = SystemLanguageModel.default.availability
  if case .available = availability {
    return ["ok": true, "availability": "available"]
  }
  if case .unavailable(let reason) = availability {
    return ["ok": true, "availability": "unavailable", "reason": String(describing: reason)]
  }
  return ["ok": true, "availability": "unavailable", "reason": "unknown"]
}

var session: LanguageModelSession?
var temperature: Double?

while let line = readLine(strippingNewline: true) {
  guard
    let data = line.data(using: .utf8),
    let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
    let op = request["op"] as? String
  else {
    writeReply(["ok": false, "error": "unparseable request line"])
    continue
  }
  switch op {
  case "availability":
    writeReply(availabilityReply())
  case "create":
    temperature = request["temperature"] as? Double
    if let instructions = request["instructions"] as? String {
      session = LanguageModelSession(instructions: instructions)
    } else {
      session = LanguageModelSession()
    }
    writeReply(["ok": true])
  case "prompt":
    guard let prompt = request["prompt"] as? String else {
      writeReply(["ok": false, "error": "prompt op requires a prompt string"])
      continue
    }
    let active = session ?? LanguageModelSession()
    session = active
    do {
      let options = GenerationOptions(temperature: temperature)
      let response = try await active.respond(to: prompt, options: options)
      writeReply(["ok": true, "text": response.content])
    } catch {
      writeReply(["ok": false, "error": String(describing: error)])
    }
  case "destroy":
    writeReply(["ok": true])
    exit(0)
  default:
    writeReply(["ok": false, "error": "unknown op \(op)"])
  }
}
`

export interface ShimCommand {
  args: string[]
  command: string
}

export type ShimReply = Record<string, unknown>

export interface ShimHandle {
  dispose(): void
  request(
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ShimReply>
}

export interface ShimSessionSpec {
  command: ShimCommand
  initialPrompts?: Message[] | undefined
  instructions?: string | undefined
  temperature?: number | undefined
}

export interface PendingReply {
  reject(error: Error): void
  resolve(reply: ShimReply): void
  timer: NodeJS.Timeout
}

const inFlightBuilds = new Map<string, Promise<string>>()

export async function buildShimBinary(
  cacheDir: string,
  binaryPath: string,
): Promise<string> {
  if (await isExecutable(binaryPath)) {
    return binaryPath
  }
  try {
    await execFileAsync('xcrun', ['--find', 'swiftc'])
  } catch (error) {
    throw new Error(
      'Swift compiler not found — install the Xcode Command Line Tools ' +
        `with \`xcode-select --install\`: ${errorMessage(error)}`,
    )
  }
  await mkdir(cacheDir, { recursive: true })
  const sourcePath = `${binaryPath}.swift`
  await writeFile(sourcePath, APPLE_FM_SHIM_SOURCE)
  const stagingPath = `${binaryPath}.${process.pid}.tmp`
  try {
    await execFileAsync(
      'xcrun',
      ['swiftc', '-O', sourcePath, '-o', stagingPath],
      { timeout: COMPILE_TIMEOUT_MS },
    )
  } catch (error) {
    throw new Error(`swiftc failed to build the shim: ${errorMessage(error)}`)
  }
  await rename(stagingPath, binaryPath)
  return binaryPath
}

export function createShimSession(spec: ShimSessionSpec): SessionLike {
  let handle: ShimHandle | undefined

  async function ensureHandle(): Promise<ShimHandle> {
    if (handle === undefined) {
      const spawned = spawnShim(spec.command)
      const payload: Record<string, unknown> = { op: 'create' }
      if (spec.instructions !== undefined) {
        payload['instructions'] = spec.instructions
      }
      if (spec.temperature !== undefined) {
        payload['temperature'] = spec.temperature
      }
      const reply = await spawned.request(payload, CREATE_TIMEOUT_MS)
      if (reply['ok'] !== true) {
        spawned.dispose()
        throw new Error(String(reply['error'] ?? 'shim create failed'))
      }
      handle = spawned
    }
    return handle
  }

  async function promptOnce(messages: Message[]): Promise<string> {
    const active = await ensureHandle()
    const prompt = flattenMessages([
      ...(spec.initialPrompts ?? []),
      ...messages,
    ])
    const reply = await active.request(
      { op: 'prompt', prompt },
      PROMPT_TIMEOUT_MS,
    )
    if (reply['ok'] !== true) {
      throw new Error(String(reply['error'] ?? 'shim prompt failed'))
    }
    return String(reply['text'] ?? '')
  }

  return {
    clone(): SessionLike {
      return createShimSession(spec)
    },
    destroy(): void {
      if (handle !== undefined) {
        handle.dispose()
        handle = undefined
      }
    },
    async prompt(messages: Message[]): Promise<string> {
      return await promptOnce(messages)
    },
    // Streaming v1 yields the full reply as one chunk; the shim protocol has
    // no token stream yet.
    promptStreaming(messages: Message[]): AsyncIterable<string> {
      return (async function* stream(): AsyncGenerator<string> {
        yield await promptOnce(messages)
      })()
    },
  }
}

export function currentHost(): {
  arch: string
  darwinMajor: number
  platform: string
} {
  return {
    arch: process.arch,
    darwinMajor: Number.parseInt(os.release(), 10) || 0,
    platform: process.platform,
  }
}

/**
 * Compile the shim from its embedded Swift source with `xcrun swiftc` and
 * cache the binary under a hash of the source, so a source change rebuilds
 * and everything else reuses. Concurrent in-process callers share one build.
 */
export async function ensureShimBinary(cacheDir: string): Promise<string> {
  const key = crypto
    .createHash('sha256')
    .update(APPLE_FM_SHIM_SOURCE)
    .digest('hex')
    .slice(0, 16)
  const binaryPath = path.join(cacheDir, `apple-fm-shim-${key}`)
  const existing = inFlightBuilds.get(binaryPath)
  if (existing !== undefined) {
    return await existing
  }
  const build = buildShimBinary(cacheDir, binaryPath).finally(() => {
    inFlightBuilds.delete(binaryPath)
  })
  inFlightBuilds.set(binaryPath, build)
  return await build
}

/**
 * Flatten odai messages into the single prompt string FoundationModels
 * accepts. A lone user message passes through raw; anything richer becomes a
 * role-tagged transcript, and a trailing assistant prefill is left open so
 * the model continues it — `mergePrefill` reconciles echo and continuation.
 */
export function flattenMessages(messages: Message[]): string {
  const [first] = messages
  if (messages.length === 1 && first !== undefined && first.role === 'user') {
    return first.content
  }
  const parts: string[] = []
  for (let i = 0, { length } = messages; i < length; i += 1) {
    const message = messages[i]
    if (message === undefined) {
      continue
    }
    if (message.role === 'system') {
      parts.push(message.content)
    } else if (message.role === 'user') {
      parts.push(`User: ${message.content}`)
    } else {
      parts.push(`Assistant: ${message.content}`)
    }
  }
  return parts.join('\n\n')
}

export async function isExecutable(filePath: string): Promise<boolean> {
  return await access(filePath, fsConstants.X_OK).then(
    () => true,
    () => false,
  )
}

export function spawnShim(command: ShimCommand): ShimHandle {
  const spawned = spawn(command.command, command.args, { stdio: 'pipe' })
  const { process: child } = spawned
  const pending: PendingReply[] = []
  let buffered = ''
  let stderrTail = ''
  let exited = false

  const failAll = (error: Error): void => {
    for (const entry of pending.splice(0)) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  // An idle shim must not hold the event loop open — each in-flight request
  // carries a referenced timeout that keeps the process alive while a reply
  // is due.
  child.unref()
  unrefStream(child.stdin)
  unrefStream(child.stdout)
  unrefStream(child.stderr)

  // No setEncoding — the spawn wrapper buffers these streams as Buffers, and
  // an encoding flip would crash its close-time concat. Decode locally, with
  // UTF-8 sequences split across chunks handled by the decoder.
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  child.stdout?.on('data', (chunk: Buffer) => {
    buffered += stdoutDecoder.write(chunk)
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
      const entry = pending.shift()
      if (entry !== undefined) {
        clearTimeout(entry.timer)
        try {
          entry.resolve(JSON.parse(line) as ShimReply)
        } catch {
          entry.reject(
            new Error(
              'shim wrote an unparseable reply: ' +
                line.slice(0, REPLY_PREVIEW_MAX_LENGTH),
            ),
          )
        }
      }
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = `${stderrTail}${stderrDecoder.write(chunk)}`.slice(
      -STDERR_TAIL_MAX_LENGTH,
    )
  })
  // The spawn promise settles on every terminal outcome — spawn failure,
  // non-zero exit, signal kill, or clean exit — so it is the one place that
  // fails whatever is still pending.
  spawned.then(
    () => {
      exited = true
      failAll(new Error('shim exited'))
    },
    error => {
      exited = true
      const detail = stderrTail === '' ? '' : `: ${stderrTail.trim()}`
      failAll(new Error(`shim exited — ${errorMessage(error)}${detail}`))
    },
  )

  return {
    dispose(): void {
      if (!exited) {
        child.kill()
      }
    },
    request(
      payload: Record<string, unknown>,
      timeoutMs: number,
    ): Promise<ShimReply> {
      return new Promise((resolve, reject) => {
        if (exited) {
          reject(new Error('shim process already exited'))
          return
        }
        const entry: PendingReply = {
          reject,
          resolve,
          timer: setTimeout(() => {
            const index = pending.indexOf(entry)
            if (index !== -1) {
              pending.splice(index, 1)
            }
            child.kill()
            reject(new Error(`shim request timed out after ${timeoutMs}ms`))
          }, timeoutMs),
        }
        pending.push(entry)
        if (child.stdin === null) {
          clearTimeout(entry.timer)
          pending.pop()
          reject(new Error('shim has no stdin pipe'))
          return
        }
        child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
          if (error) {
            const index = pending.indexOf(entry)
            if (index !== -1) {
              pending.splice(index, 1)
            }
            clearTimeout(entry.timer)
            reject(new Error(`shim write failed: ${errorMessage(error)}`))
          }
        })
      })
    },
  }
}

/**
 * Unref a child stdio stream. The spawn wrapper's duplicated stream types
 * omit `unref`, so this reaches it structurally.
 */
export function unrefStream(stream: unknown): void {
  const candidate = stream as { unref?: (() => void) | undefined } | null
  if (candidate !== null && typeof candidate?.unref === 'function') {
    candidate.unref()
  }
}
