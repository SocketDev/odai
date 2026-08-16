/**
 * @file Odai CLI task dispatch. Maps a parsed CLI command to its task function
 *   over the model interface — text tasks take the raw stdin string; the
 *   structured dep-update tasks (dedupe / hoist / security-fix / weekly-update)
 *   take a JSON object parsed from stdin. Split from run.mts so the command
 *   runner (stdin, timeout, backend lifecycle) and this pure dispatch table
 *   stay independently testable.
 */

import { joinOr } from '@socketsecurity/lib/arrays/join'

import { classifyDependencyChange } from '../tasks/classify-deps.mts'
import { suggestCommitMessage } from '../tasks/commit.mts'
import { dedupeDependencies } from '../tasks/dedupe.mts'
import { assessHoistSafety } from '../tasks/hoist.mts'
import { reasonAboutLockfile } from '../tasks/lockfile.mts'
import { generateCodePatch } from '../tasks/patch.mts'
import { assessSecurityFix } from '../tasks/security-fix.mts'
import { summarizeText } from '../tasks/summarize.mts'
import { triageAlerts } from '../tasks/triage.mts'
import { planWeeklyUpdate } from '../tasks/weekly-update.mts'
import { CliUsageError } from './args.mts'
import type { CliCommand } from './args.mts'
import type { HoistInput } from '../prompts/hoist.mts'
import type { SecurityFixInput } from '../prompts/security-fix.mts'
import type { WeeklyUpdateInput } from '../prompts/weekly-update.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

/**
 * Parse a command's stdin as the JSON input object a structured task expects.
 * Throws a usage error with the expected shape when the input is not valid
 * JSON — the structured commands (dedupe, hoist, security-fix, weekly-update)
 * take an object, not a plain string.
 */
export function parseJsonInput(
  input: string,
  command: CliCommand,
  shape: string,
): unknown {
  try {
    return JSON.parse(input)
  } catch {
    throw new CliUsageError(
      `odai: ${command} expects JSON on stdin shaped ${shape}.`,
    )
  }
}

export async function runTask(
  command: CliCommand,
  model: OdaiModel,
  input: string,
  instruction: string | undefined,
): Promise<TaskResult<unknown>> {
  switch (command) {
    case 'classify-deps':
      return await classifyDependencyChange(model, input)
    case 'commit-msg':
      return await suggestCommitMessage(model, input)
    case 'dedupe': {
      const parsed = parseJsonInput(
        input,
        'dedupe',
        '{ "manifest": "<package.json>", "lockfile": "<lock excerpt>" }',
      ) as { lockfile: string; manifest: string }
      return await dedupeDependencies(model, parsed.manifest, parsed.lockfile)
    }
    case 'hoist':
      return await assessHoistSafety(
        model,
        parseJsonInput(
          input,
          'hoist',
          '{ "changelog", "currentVersion", "targetVersion", "minNodeSupported" }',
        ) as HoistInput,
      )
    case 'lockfile':
      return await reasonAboutLockfile(model, input)
    case 'patch': {
      if (instruction === undefined) {
        throw new CliUsageError(
          'odai: patch needs --instruction <text> describing the change.',
        )
      }
      return await generateCodePatch(model, input, instruction)
    }
    case 'security-fix':
      return await assessSecurityFix(
        model,
        parseJsonInput(
          input,
          'security-fix',
          '{ "advisory", "affectedRange", "availableVersions", "currentVersion" }',
        ) as SecurityFixInput,
      )
    case 'summarize':
      return await summarizeText(model, input)
    case 'triage':
      return await triageAlerts(model, input)
    case 'weekly-update':
      return await planWeeklyUpdate(
        model,
        parseJsonInput(
          input,
          'weekly-update',
          '{ "outdated": "<dep list>", "soakWindowDays": 7 }',
        ) as WeeklyUpdateInput,
      )
    default:
      throw new CliUsageError(
        `odai: "${command}" is not a prompt command; expected ` +
          `${joinOr([
            'classify-deps',
            'commit-msg',
            'dedupe',
            'hoist',
            'lockfile',
            'patch',
            'security-fix',
            'summarize',
            'triage',
            'weekly-update',
          ])}.`,
      )
  }
}
