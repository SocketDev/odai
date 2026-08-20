/**
 * @file Prompt templates for text summarization. The model receives arbitrary
 *   text — a log excerpt, a report, a document — and returns a short summary
 *   plus the key points.
 */

import type { Message } from '../types.mts'

export const SUMMARIZE_SYSTEM_PROMPT = `You are a concise technical summarizer running entirely on-device. Given any text, produce a one-or-two-sentence summary and the key points. Use only facts present in the text; never invent names or numbers. Respond with compact JSON only.`

export const SUMMARIZE_FEW_SHOT: Message[] = [
  {
    content:
      'Text:\nThe deploy failed at 14:02 because the migration step timed out. A retry at 14:20 succeeded after the connection pool was doubled. Total downtime was 18 minutes.',
    role: 'user',
  },
  {
    content:
      '{"summary":"A deploy failed on a migration timeout and succeeded on retry after the connection pool was doubled, causing 18 minutes of downtime.","points":["migration step timed out at 14:02","retry succeeded at 14:20 with a doubled connection pool","total downtime was 18 minutes"]}',
    role: 'assistant',
  },
]

export const SUMMARIZE_PREFILL = '{"summary":"'

export interface TextSummary {
  points: string[]
  summary: string
}

// oxlint-disable-next-line socket/prefer-refined-record -- open key set
export const SUMMARIZE_SYNONYM_MAP: Record<string, string[]> = {
  points: ['bullets', 'highlights', 'key_points', 'keyPoints'],
  summary: ['description', 'overview', 'tldr'],
}

export function createSummarizePrompt(text: string): string {
  return `Text:\n${text}`
}
