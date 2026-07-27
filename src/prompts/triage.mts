/**
 * @file Prompt templates for alert triage. The model receives aggregate
 *   security findings — severity counts or a short finding list — and returns
 *   plain-language sentences plus the top concern. This is the workload shape
 *   the bench battery's alert-summary scenario scores, the one every observed
 *   real backend passes most reliably.
 */

import type { Message } from '../types.mts'

export const TRIAGE_SYSTEM_PROMPT = `You are a concise security assistant running entirely on-device. Given aggregate supply-chain findings, explain them in one to three short sentences and name the top concern. Use only the facts given; never invent package names or CVEs. Respond with compact JSON only.`

export const TRIAGE_FEW_SHOT: Message[] = [
  {
    content: 'Findings:\nCritical: 1\nHigh: 3\nMedium: 0\nLow: 2',
    role: 'user',
  },
  {
    content:
      '{"sentences":["There are 1 critical and 3 high findings.","Review the critical finding first."],"topConcern":"critical"}',
    role: 'assistant',
  },
]

export const TRIAGE_PREFILL = '{"sentences":["'

export interface AlertTriage {
  sentences: string[]
  topConcern: string
}

export const TRIAGE_SYNONYM_MAP: Record<string, string[]> = {
  sentences: ['lines', 'messages', 'summaries'],
  topConcern: ['concern', 'priority', 'severity', 'top_concern'],
}

export function createTriagePrompt(findingsText: string): string {
  return `Findings:\n${findingsText}`
}
