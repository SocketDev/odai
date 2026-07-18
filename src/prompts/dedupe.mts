/**
 * @file Prompt templates for dependency deduplication. The model receives a
 *   manifest and lockfile excerpt and returns a list of merge candidates.
 */

import type { Message } from '../types.mts'

export const DEDUPE_SYSTEM_PROMPT = `You are a dependency-deduplication assistant running entirely on-device. Given a manifest and lockfile excerpt, suggest concrete package merges that would reduce install size. Respond with compact JSON only.`

export const DEDUPE_FEW_SHOT: Message[] = [
  {
    content:
      'Manifest:\n{\n  "dependencies": {\n    "chalk": "^5.0.0",\n    "gradient-string": "^2.0.0"\n  }\n}\nLockfile excerpt:\nnode_modules/chalk@5.3.0\nnode_modules/ansi-styles@6.2.1\nnode_modules/chalk@4.1.2 (transitive via gradient-string)',
    role: 'user',
  },
  {
    content:
      '{"suggestions":[{"packages":["chalk"],"recommendedVersion":"5.3.0","reasoning":"chalk 4.1.2 is pulled transitively by gradient-string; both packages use chalk 5 compatible APIs, so align on 5.3.0"}]}',
    role: 'assistant',
  },
]

export const DEDUPE_PREFILL = '{"suggestions":['

export interface DedupeSuggestion {
  packages: string[]
  recommendedVersion: string
  reasoning: string
}

export interface DedupeResult {
  suggestions: DedupeSuggestion[]
}

export const DEDUPE_SYNONYM_MAP: Record<string, string[]> = {
  packages: ['packageNames', 'names'],
  reasoning: ['reason', 'rationale', 'explanation'],
  recommendedVersion: ['targetVersion', 'version'],
  suggestions: ['recommendations', 'merges'],
}

export function createDedupePrompt(
  manifestText: string,
  lockfileText: string,
): string {
  return `Manifest:\n${manifestText}\nLockfile excerpt:\n${lockfileText}`
}
