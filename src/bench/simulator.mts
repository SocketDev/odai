/**
 * @file Pre-built LanguageModel simulator rules for the bench scenario
 *   battery. Lets the evaluator run end-to-end in Node or node-smol without
 *   Chrome.
 */

import {
  ALTERNATIVE_PACKAGE_PROMPT,
  ASK_QUERIES,
  CODE_PATCH_INPUT,
  CODE_REPAIR_INPUT,
  LOCKFILE_DEDUPE_CANDIDATE,
  LOCKFILE_DUPLICATE_LODASH,
  MANIFEST_DEDUPE_CANDIDATE,
  SBOM_ANOMALY_INPUT,
  SEVERITY_COUNTS,
} from './fixtures.mts'
import type { ResponseRule } from '../simulator.mts'

export function createBenchResponseRules(): ResponseRule[] {
  return [
    {
      response: JSON.stringify({
        findings: [
          {
            package: 'lodash',
            reason:
              'duplicate version 4.17.15 alongside lodash-es 4.17.21 in the same tree',
            severity: 'low',
          },
        ],
        summary:
          'lodash is pinned to an older patch than lodash-es; consider aligning to a single version.',
      }),
      when: text => text.includes(LOCKFILE_DUPLICATE_LODASH.slice(0, 40)),
    },
    {
      response: JSON.stringify({
        suggestions: [
          {
            packages: ['chalk'],
            recommendedVersion: '5.3.0',
            reasoning:
              'chalk 4.1.2 is pulled transitively by gradient-string; align on 5.3.0',
          },
        ],
      }),
      when: text =>
        text.includes(MANIFEST_DEDUPE_CANDIDATE.slice(0, 40)) &&
        text.includes(LOCKFILE_DEDUPE_CANDIDATE.slice(0, 40)),
    },
    {
      response: JSON.stringify({
        explanation: 'Replaced string concatenation with a template literal.',
        patch: `--- a/greet.js\n+++ b/greet.js\n@@ -1,3 +1,3 @@\n function greet(name) {\n-  console.log("Hello " + name);\n+  console.log(\`Hello \${name}\`);\n }`,
      }),
      when: text =>
        text.includes(CODE_PATCH_INPUT.slice(0, 30)) &&
        text.includes('template literal'),
    },
    {
      response: JSON.stringify({
        explanation:
          'Removed the unused deepEqual import and replaced == with ===.',
        fixed: `import { join } from 'node:path'\n\nexport function resolveConfigPath(root, name) {\n  if (name === '') {\n    return join(root, 'default.json')\n  }\n  return join(root, name)\n}`,
      }),
      when: text =>
        text.includes(CODE_REPAIR_INPUT.slice(0, 40)) &&
        text.includes('lint error'),
    },
    {
      response: JSON.stringify({
        sentences: [
          `There are ${SEVERITY_COUNTS.critical} critical and ${SEVERITY_COUNTS.high} high findings.`,
          'Review the affected packages in Socket.',
        ],
        topConcern: 'critical',
      }),
      when: text => text.includes(`Critical: ${SEVERITY_COUNTS.critical}`),
    },
    {
      response: JSON.stringify({
        command: ['fix'],
        confidence: 0.95,
        intent: 'fix',
      }),
      when: text => text.includes(ASK_QUERIES[1]!),
    },
    {
      response: JSON.stringify({
        alternative: 'lodash-es',
        reasoning:
          'lodash-es is the ESM build maintained by the same team and avoids the flagged prototype-pollution path.',
      }),
      when: text => text.includes(ALTERNATIVE_PACKAGE_PROMPT.slice(0, 60)),
    },
    {
      response: JSON.stringify({
        anomalies: [
          'duplicate component: chalk appears as 5.3.0 and 4.1.2',
          'deprecated component: left-pad@1.3.0',
          'untrusted source: eval-evil is a git dependency without a tag',
        ],
        summary:
          'duplicate component versions, one deprecated package, and one untrusted git dependency.',
      }),
      when: text => text.includes(SBOM_ANOMALY_INPUT.slice(0, 40)),
    },
    // Hoist decisions. Matchers key on text unique to each changelog's user
    // turn, not the shared few-shot (whose examples share a `## X.0.0` prefix).
    {
      response: JSON.stringify({
        breakingChanges: ['Drop support for Node.js 18 and 20'],
        reason:
          'The only breaking change drops Node 18 and 20, both below the project minimum of 22.',
        verdict: 'safe',
      }),
      when: text => text.includes('Node.js 18 and 20'),
    },
    {
      response: JSON.stringify({
        breakingChanges: ['Remove the deprecated readSync() export'],
        reason:
          'Removing readSync() is a real API change that can break consumers regardless of Node version.',
        verdict: 'unsafe',
      }),
      when: text => text.includes('readSync()'),
    },
    {
      response: JSON.stringify({
        breakingChanges: ['Require Node.js 24+'],
        reason:
          'Dropping Node 22 removes a Node major the project still supports.',
        verdict: 'unsafe',
      }),
      when: text => text.includes('Require Node.js 24'),
    },
    {
      response: JSON.stringify({
        breakingChanges: [],
        reason:
          'The changelog is truncated and lists no concrete breaking changes.',
        verdict: 'abstain',
      }),
      when: text => text.includes('Various internal changes'),
    },
    // Security-fix decisions: the minimal available version outside the range.
    {
      response: JSON.stringify({
        fixedVersion: '6.2.2',
        reason: '6.2.1 is also affected, so 6.2.2 is the minimal safe version.',
        verdict: 'fixed',
      }),
      when: text => text.includes('does not fully address'),
    },
    {
      response: JSON.stringify({
        fixedVersion: '9.0.0',
        reason:
          '9.0.0 is the lowest available version outside the affected range; 10.0.0 would be a needless major bump.',
        verdict: 'fixed',
      }),
      when: text => text.includes('ReDoS in minimatch'),
    },
    {
      response: JSON.stringify({
        reason: 'Every available version is within the affected range.',
        verdict: 'no-safe-version',
      }),
      when: text => text.includes('Prototype pollution in qs-legacy'),
    },
    // Weekly-update plans: propose only deps whose latest cleared the soak
    // window. The undici rule precedes the zod rule so the mixed fixture
    // (both deps) resolves to undici-only.
    {
      response: JSON.stringify({
        updates: [
          {
            from: '6.0.0',
            name: 'undici',
            reason: 'Latest has soaked 12 days, past the 7-day window.',
            to: '6.1.0',
          },
        ],
      }),
      when: text => text.includes('undici current 6.0.0'),
    },
    {
      response: JSON.stringify({ updates: [] }),
      when: text => text.includes('current 3.22.0'),
    },
  ]
}
