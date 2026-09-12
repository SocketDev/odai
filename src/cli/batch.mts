/**
 * @file Manifest parsing and sequential entry loop for the odai batch command.
 *   Pure functions — no I/O; the writeLine sink and model are injected so
 *   tests exercise every path without a real backend.
 */

import { joinOr } from '@socketsecurity/lib/arrays/join'
import { errorMessage } from '@socketsecurity/lib/errors/message'

import { CliUsageError } from './args.mts'
import { TASK_NAMES } from './commands.mts'
import type { TaskCommand } from './commands.mts'
import { runTask } from './dispatch.mts'
import { withTimeout } from './runtime.mts'
import type { LineWriter } from './runtime.mts'
import type { OdaiModel } from '../model.mts'

export const BATCH_MANIFEST_SHAPE =
  '{"id":"<unique>","task":"<command>","input":<string or object>,"instruction":"<patch only>"}'

export type BatchTaskCommand = TaskCommand

export const BATCH_TASK_COMMANDS: readonly BatchTaskCommand[] = TASK_NAMES

export interface BatchEntry {
  id: string
  input: string
  instruction?: string | undefined
  task: BatchTaskCommand
}

export type BatchResultLine =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: string }

export function isBatchTaskCommand(value: string): value is BatchTaskCommand {
  return (BATCH_TASK_COMMANDS as readonly string[]).includes(value)
}

export function parseBatchId(
  entry: Record<string, unknown>,
  line: number,
  seen: Set<string>,
): string {
  const id = entry['id']
  if (typeof id !== 'string' || id === '') {
    throw new CliUsageError(
      `odai batch: line ${line} needs a non-empty string "id".`,
    )
  }
  if (seen.has(id)) {
    throw new CliUsageError(
      `odai batch: line ${line} reuses id "${id}" — ids must be unique across the manifest.`,
    )
  }
  seen.add(id)
  return id
}

export function parseBatchInput(value: unknown, line: number): string {
  if (typeof value === 'string') {
    if (value === '') {
      throw new CliUsageError(`odai batch: line ${line} "input" is empty.`)
    }
    return value
  }
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value)
  }
  throw new CliUsageError(
    `odai batch: line ${line} "input" must be a string or a JSON object.`,
  )
}

export function parseBatchInstruction(
  value: unknown,
  task: BatchTaskCommand,
  line: number,
): string | undefined {
  if (task === 'patch') {
    if (typeof value !== 'string' || value === '') {
      throw new CliUsageError(
        `odai batch: line ${line} patch needs an "instruction" string describing the change.`,
      )
    }
    return value
  }
  if (value !== undefined) {
    throw new CliUsageError(
      `odai batch: line ${line} "instruction" only applies to patch, not ${task}.`,
    )
  }
  return undefined
}

export function parseBatchLine(
  raw: string,
  line: number,
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CliUsageError(
      `odai batch: line ${line} is not valid JSON — each manifest line is ${BATCH_MANIFEST_SHAPE}.`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliUsageError(
      `odai batch: line ${line} must be a JSON object shaped ${BATCH_MANIFEST_SHAPE}.`,
    )
  }
  return parsed as Record<string, unknown>
}

export function parseBatchManifest(text: string): BatchEntry[] {
  const lines = text.split(/\r?\n/)
  const entries: BatchEntry[] = []
  const seen = new Set<string>()
  for (let i = 0, { length } = lines; i < length; i += 1) {
    const raw = lines[i]!
    if (raw.trim() === '') {
      continue
    }
    const line = i + 1
    const entry = parseBatchLine(raw, line)
    const id = parseBatchId(entry, line, seen)
    const task = parseBatchTask(entry['task'], line)
    const input = parseBatchInput(entry['input'], line)
    const instruction = parseBatchInstruction(entry['instruction'], task, line)
    entries.push({
      id,
      input,
      ...(instruction !== undefined ? { instruction } : {}),
      task,
    })
  }
  if (entries.length === 0) {
    throw new CliUsageError(
      `odai batch: the manifest is empty — pass at least one JSONL line shaped ${BATCH_MANIFEST_SHAPE}.`,
    )
  }
  return entries
}

export function parseBatchTask(value: unknown, line: number): BatchTaskCommand {
  if (typeof value !== 'string' || !isBatchTaskCommand(value)) {
    throw new CliUsageError(
      `odai batch: line ${line} task ${JSON.stringify(value)} is not a batch task; expected ${joinOr([...BATCH_TASK_COMMANDS])}.`,
    )
  }
  return value
}

export async function runBatchEntries(
  model: OdaiModel,
  entries: readonly BatchEntry[],
  timeoutMs: number,
  writeLine: LineWriter,
): Promise<void> {
  for (let i = 0, { length } = entries; i < length; i += 1) {
    const entry = entries[i]!
    let line: BatchResultLine
    try {
      const result = await withTimeout(
        runTask(entry.task, model, entry.input, entry.instruction),
        timeoutMs,
        `odai batch ${entry.id}: the ${entry.task} task`,
      )
      if (result.ok && result.data !== undefined) {
        line = { id: entry.id, ok: true, value: result.data }
      } else {
        line = {
          id: entry.id,
          ok: false,
          error: `the ${entry.task} reply failed validation — ${result.error ?? 'no parse error recorded'}`,
        }
      }
    } catch (e) {
      line = { id: entry.id, ok: false, error: errorMessage(e) }
    }
    writeLine(JSON.stringify(line))
  }
}
