/**
 * @file Prompt templates for commit-message suggestion. The model receives a
 *   diff and returns a Conventional Commits subject line.
 */

import type { Message } from '../types.mts'

export const COMMIT_SYSTEM_PROMPT = `You are a commit-message assistant running entirely on-device. Given a diff, produce one Conventional Commits subject line: <type>(<scope>): <description>, lowercase after the colon, imperative mood, under 72 characters, no trailing period. Types: feat, fix, refactor, chore, docs, style, test, perf, build, ci. Respond with compact JSON only.`

export const COMMIT_FEW_SHOT: Message[] = [
  {
    content:
      'Diff:\n--- a/src/parse.js\n+++ b/src/parse.js\n@@ -10,7 +10,7 @@\n function parse(input) {\n-  return JSON.parse(input)\n+  return input === "" ? {} : JSON.parse(input)\n }',
    role: 'user',
  },
  {
    content: '{"subject":"fix(parse): return empty object for empty input"}',
    role: 'assistant',
  },
]

export const COMMIT_PREFILL = '{"subject":"'

export interface CommitMessage {
  subject: string
}

export const COMMIT_SYNONYM_MAP: Record<string, string[]> = {
  subject: ['commit', 'commitMessage', 'header', 'message', 'title'],
}

export function createCommitMessagePrompt(diff: string): string {
  return `Diff:\n${diff}`
}
