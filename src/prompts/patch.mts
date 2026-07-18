/**
 * @file Prompt templates for code patching. The model receives a file snippet
 *   and an instruction, then returns a unified-diff-style patch.
 */

import type { Message } from '../types.mts'

export const PATCH_SYSTEM_PROMPT = `You are a code-patching assistant running entirely on-device. Given a code snippet and an instruction, produce a minimal patch in unified diff format. Respond with compact JSON only.`

export const PATCH_FEW_SHOT: Message[] = [
  {
    content:
      'File:\nfunction greet(name) {\n  console.log("Hello " + name);\n}\nInstruction: use a template literal',
    role: 'user',
  },
  {
    content:
      '{"patch":"--- a/greet.js\\n+++ b/greet.js\\n@@ -1,3 +1,3 @@\\n function greet(name) {\\n-  console.log(\\"Hello \\" + name);\\n+  console.log(`Hello ${name}`);\\n }","explanation":"Replaced string concatenation with a template literal for clarity."}',
    role: 'assistant',
  },
]

export const PATCH_PREFILL = '{"patch":"'

export interface CodePatch {
  explanation: string
  patch: string
}

export const PATCH_SYNONYM_MAP: Record<string, string[]> = {
  explanation: ['reason', 'rationale', 'details'],
  patch: ['diff', 'change', 'fix'],
}

export function createPatchPrompt(
  fileContent: string,
  instruction: string,
): string {
  return `File:\n${fileContent}\nInstruction: ${instruction}`
}
