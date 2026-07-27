/**
 * @file Prompt templates for dependency-change classification. The model
 *   receives a pre-narrowed dependency diff — the bounded JSON a weekly-update
 *   diff-narrow step emits, with the lockfile body collapsed to counts — and
 *   returns an advisory flag: is this a routine bump or a supply-chain surprise
 *   a human should eyeball? It never blocks a PR; it labels one. Because the
 *   narrowing step caps the input, this prompt fits a small on-device model.
 */

import type { Message } from '../types.mts'

export const CLASSIFY_DEPS_SYSTEM_PROMPT = `You are a supply-chain review assistant running entirely on-device. Given a pre-narrowed dependency diff from an automated update, decide whether it is a routine bump or a surprise worth human review. Surprises: a major version jump, a package that gained install/lifecycle scripts, a brand-new dependency name, or a typosquat-shaped name. Routine: patch or minor bumps with no new install scripts. Use only the facts given; never invent packages. Respond with compact JSON only.`

export const CLASSIFY_DEPS_FEW_SHOT: Message[] = [
  {
    content:
      'Dependency diff:\n{"addedDeps":[{"name":"simple-icons","from":"^16.26.0","to":"^16.27.0","major":false,"newInstallScripts":false}],"newTransitiveCount":0,"droppedLockfileBody":true}',
    role: 'user',
  },
  {
    content:
      '{"surprise":false,"flags":[],"note":"simple-icons is a minor bump with no new install scripts"}',
    role: 'assistant',
  },
  {
    content:
      'Dependency diff:\n{"addedDeps":[{"name":"left-pad","from":null,"to":"1.3.0","major":false,"newInstallScripts":true}],"newTransitiveCount":12,"droppedLockfileBody":true}',
    role: 'user',
  },
  {
    content:
      '{"surprise":true,"flags":["new-dependency","new-install-scripts"],"note":"left-pad is newly added and ships install scripts; review before merge"}',
    role: 'assistant',
  },
]

export const CLASSIFY_DEPS_PREFILL = '{"surprise":'

export interface DepClassification {
  flags: string[]
  note: string
  surprise: boolean
}

export const CLASSIFY_DEPS_SYNONYM_MAP: Record<string, string[]> = {
  flags: ['reasons', 'signals', 'tags', 'labels'],
  note: ['reason', 'rationale', 'explanation', 'summary'],
  surprise: ['isSurprise', 'surprising', 'flagged', 'suspicious'],
}

export function createClassifyDepsPrompt(narrowedDiffText: string): string {
  return `Dependency diff:\n${narrowedDiffText}`
}
