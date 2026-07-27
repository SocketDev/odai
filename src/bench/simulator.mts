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
  ]
}
