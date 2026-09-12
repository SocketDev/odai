import { TASK_COMMANDS, TASK_NAMES } from './cli/commands.mts'
import type { BackendName } from './backends/types.mts'

export const REASONING_HEAVY_TASKS: ReadonlySet<string> = new Set(
  TASK_NAMES.filter(name => TASK_COMMANDS[name].heavy),
)

export interface BackendForTaskOptions {
  heavyBackend?: BackendName | undefined
}

export function backendForTask(
  taskName: string,
  options: BackendForTaskOptions = {},
): BackendName {
  return REASONING_HEAVY_TASKS.has(taskName)
    ? (options.heavyBackend ?? 'llama-server')
    : 'chrome-builtin'
}

export function preferredTaskBackend(
  tasks: readonly string[],
): BackendName | undefined {
  const heavyTask = tasks.find(task => REASONING_HEAVY_TASKS.has(task))
  return heavyTask === undefined ? undefined : backendForTask(heavyTask)
}
