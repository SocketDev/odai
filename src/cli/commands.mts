export const TASK_COMMANDS = {
  'classify-deps': {
    description: 'flag a narrowed dependency diff as routine or surprise',
    heavy: false,
  },
  'commit-msg': {
    description: 'suggest a Conventional Commits subject for a diff',
    heavy: false,
  },
  dedupe: {
    description: 'which package versions collapse safely (JSON stdin)',
    heavy: false,
  },
  hoist: {
    description: 'assess a cross-major hoist from a changelog (JSON stdin)',
    heavy: false,
  },
  lockfile: { description: 'reason about a lockfile excerpt', heavy: false },
  lockstep: {
    description:
      'analyze full or sparse upstream lockstep evidence (JSON stdin)',
    heavy: true,
  },
  patch: {
    description: 'generate a unified-diff code patch for a file',
    heavy: true,
  },
  pricing: {
    description:
      'extract per-token model prices from a pricing page (JSON stdin)',
    heavy: false,
  },
  'security-fix': {
    description: 'pick the minimal safe upgrade for an advisory (JSON stdin)',
    heavy: false,
  },
  summarize: {
    description: 'condense text into a summary plus key points',
    heavy: false,
  },
  triage: {
    description: 'explain aggregate security findings in plain language',
    heavy: false,
  },
  'weekly-update': {
    description: 'plan soak-gated dependency updates (JSON stdin)',
    heavy: false,
  },
} as const

export type TaskCommand = keyof typeof TASK_COMMANDS

export const TASK_NAMES = Object.keys(TASK_COMMANDS) as TaskCommand[]

export function isTaskCommand(value: string): value is TaskCommand {
  return Object.hasOwn(TASK_COMMANDS, value)
}
