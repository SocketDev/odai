/**
 * @file Manifest parsing and sequential entry loop for the odai batch command.
 *   Pure functions — no I/O; the writeLine sink and model are injected so
 *   tests exercise every path without a real backend.
 */

import { joinOr } from '@socketsecurity/lib/arrays/join'
import { errorMessage } from '@socketsecurity/lib/errors/message'

import { CLI_COMMANDS, CliUsageError } from './args.mts'
import { runTask } from './dispatch.mts'
import { withTimeout } from './run.mts'
import type { CliCommand } from './args.mts'
import type { LineWriter } from './run.mts'
import type { OdaiModel } from '../model.mts'

export const BATCH_MANIFEST_SHAPE =
  '{"id":"<unique>","task":"<command>","input":<string or object>,"instruction":"<patch only>"}'

export type BatchTaskCommand = Exclude<CliCommand, 'backends' | 'batch'>

export const BATCH_TASK_COMMANDS: readonly BatchTaskCommand[] =
  CLI_COMMANDS.filter(
    (command): command is BatchTaskCommand =>
      command !== 'backends' && command !== 'batch',
  )

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

export function parseBatchManifest(text: string): BatchEntry[] {
  const lines = text.split('\n')
  const entries: BatchEntry[] = []
  const seen = new Set<string>()

  for (let i = 0; i < lines.length; i += 1) {
    const n = i + 1
    const raw = lines[i]!
    if (raw.trim() === '') {
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new CliUsageError(
        `odai batch: line ${n} is not valid JSON — each manifest line is ${BATCH_MANIFEST_SHAPE}.`,
      )
    }

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new CliUsageError(
        `odai batch: line ${n} must be a JSON object shaped ${BATCH_MANIFEST_SHAPE}.`,
      )
    }

    const entry = parsed as Record<string, unknown>

    if (typeof entry['id'] !== 'string' || entry['id'] === '') {
      throw new CliUsageError(
        `odai batch: line ${n} needs a non-empty string "id".`,
      )
    }
    const id = entry['id']

    if (seen.has(id)) {
      throw new CliUsageError(
        `odai batch: line ${n} reuses id "${id}" — ids must be unique across the manifest.`,
      )
    }
    seen.add(id)

    const rawTask = entry['task']
    if (typeof rawTask !== 'string' || !isBatchTaskCommand(rawTask)) {
      throw new CliUsageError(
        `odai batch: line ${n} task ${JSON.stringify(rawTask)} is not a batch task; expected ${joinOr([...BATCH_TASK_COMMANDS])}.`,
      )
    }
    const task = rawTask

    const rawInput = entry['input']
    let input: string
    if (typeof rawInput === 'string') {
      if (rawInput === '') {
        throw new CliUsageError(`odai batch: line ${n} "input" is empty.`)
      }
      input = rawInput
    } else if (rawInput !== null && typeof rawInput === 'object') {
      input = JSON.stringify(rawInput)
    } else {
      throw new CliUsageError(
        `odai batch: line ${n} "input" must be a string or a JSON object.`,
      )
    }

    const rawInstruction = entry['instruction']
    let instruction: string | undefined
    if (task === 'patch') {
      if (typeof rawInstruction !== 'string' || rawInstruction === '') {
        throw new CliUsageError(
          `odai batch: line ${n} patch needs an "instruction" string describing the change.`,
        )
      }
      instruction = rawInstruction
    } else if (rawInstruction !== undefined) {
      throw new CliUsageError(
        `odai batch: line ${n} "instruction" only applies to patch, not ${task}.`,
      )
    }

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

export async function runBatchEntries(
  model: OdaiModel,
  entries: readonly BatchEntry[],
  timeoutMs: number,
  writeLine: LineWriter,
): Promise<void> {
  for (const entry of entries) {
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
