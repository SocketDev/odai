/**
 * @file Prompt templates for lockfile reasoning. Kept small so a 4 GB on-device
 *   model can process them reliably; few-shot examples anchor the output shape.
 */

import type { Message } from '../types.mts'

export const LOCKFILE_SYSTEM_PROMPT = `You are a dependency-security assistant running entirely on-device. Given a package lockfile excerpt, identify the most important concerns: duplicate packages, suspicious version ranges, and obvious outdated patterns. Respond with compact JSON only.`

export const LOCKFILE_FEW_SHOT: Message[] = [
  {
    content:
      'Reason about this lockfile excerpt:\n{\n  "name": "demo",\n  "lockfileVersion": 3,\n  "packages": {\n    "node_modules/lodash": {\n      "version": "4.17.15"\n    },\n    "node_modules/lodash-es": {\n      "version": "4.17.21"\n    }\n  }\n}',
    role: 'user',
  },
  {
    content:
      '{"summary":" lodash is pinned to an older patch than lodash-es; consider aligning to a single version.","findings":[{"severity":"low","package":"lodash","reason":"version 4.17.15 lags lodash-es 4.17.21 in the same tree"}]}',
    role: 'assistant',
  },
]

export const LOCKFILE_PREFILL = '{"summary":"'

export interface LockfileFinding {
  package: string
  reason: string
  severity: 'high' | 'low' | 'medium'
}

export interface LockfileReasoning {
  findings: LockfileFinding[]
  summary: string
}

export const LOCKFILE_SYNONYM_MAP: Record<string, string[]> = {
  findings: ['issues', 'problems', 'concerns', 'alerts'],
  package: ['name', 'pkg'],
  reason: ['rationale', 'explanation', 'details'],
  severity: ['level', 'risk'],
  summary: ['overview', 'conclusion'],
}

export function createLockfilePrompt(lockfileText: string): string {
  return `Reason about this lockfile excerpt:\n${lockfileText}`
}
