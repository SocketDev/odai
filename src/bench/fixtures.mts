/**
 * @file Real-world fixtures for the bench evaluator. Keep inputs
 *   small enough to fit in a 4 GB on-device context window while still being
 *   representative of the Socket product surface.
 */

export const LOCKFILE_DUPLICATE_LODASH = `{
  "name": "demo",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/lodash": { "version": "4.17.15" },
    "node_modules/lodash-es": { "version": "4.17.21" },
    "node_modules/ansi-styles": { "version": "6.2.1" },
    "node_modules/chalk": { "version": "5.3.0" },
    "node_modules/chalk/node_modules/ansi-styles": { "version": "4.3.0" }
  }
}`

export const MANIFEST_DEDUPE_CANDIDATE = `{
  "dependencies": {
    "chalk": "^5.0.0",
    "gradient-string": "^2.0.0"
  }
}`

export const LOCKFILE_DEDUPE_CANDIDATE = `node_modules/chalk@5.3.0
node_modules/ansi-styles@6.2.1
node_modules/chalk@4.1.2 (transitive via gradient-string)
node_modules/ansi-styles@4.3.0 (transitive via chalk@4.1.2)`

export const CODE_PATCH_INPUT = `function greet(name) {
  console.log("Hello " + name);
}`

export const CODE_REPAIR_INPUT = `import { deepEqual } from 'node:assert'
import { join } from 'node:path'

export function resolveConfigPath(root, name) {
  if (name == '') {
    return join(root, 'default.json')
  }
  return join(root, name)
}`

export const CODE_REPAIR_LINT_ERRORS = `resolve-config.js:1:10 error no-unused-vars: 'deepEqual' is imported but never used.
resolve-config.js:5:12 error eqeqeq: Expected '===' and instead saw '=='.`

export const SEVERITY_COUNTS = {
  critical: 2,
  high: 5,
  low: 12,
  medium: 8,
}

export const ASK_QUERIES = [
  'scan my project for vulnerabilities',
  'fix critical issues',
  'is express safe to use',
  'optimize my dependencies',
]

export const ALTERNATIVE_PACKAGE_PROMPT = `Package: lodash@4.17.15
Severity: high
Alert types: prototype-pollution, cve
Socket alternate: lodash-es`

export const SBOM_ANOMALY_INPUT = `Components:
- pkg:npm/lodash@4.17.15
- pkg:npm/lodash-es@4.17.21
- pkg:npm/chalk@5.3.0
- pkg:npm/chalk@4.1.2
- pkg:npm/left-pad@1.3.0 (deprecated)
- pkg:npm/eval-evil@1.0.0 (git dependency, no tag)`

// Hoist decision fixtures. The project's minimum supported Node major is 22 in
// every hoist scenario, so a changelog that only drops Node <= 22 is safe.
export const HOIST_MIN_NODE_MAJOR = 22

// SAFE: the sole breaking change drops Node majors below the project minimum.
export const HOIST_NODE_ONLY_CHANGELOG = `## 3.0.0
### BREAKING CHANGES
- Drop support for Node.js 18 and 20. Node.js 22+ is now required.
### Features
- Faster cold start via lazy imports.`

// UNSAFE: a real API removal, independent of Node version.
export const HOIST_REAL_BREAKING_CHANGELOG = `## 5.0.0
### BREAKING CHANGES
- Remove the deprecated \`readSync()\` export; use \`read()\` which returns a promise.
- Drop support for Node.js 18.`

// UNSAFE: drops a Node major the project still supports (24 > our minimum 22).
export const HOIST_NODE_ABOVE_MIN_CHANGELOG = `## 4.0.0
### BREAKING CHANGES
- Require Node.js 24+. Support for Node.js 22 and below is dropped.`

// ABSTAIN: the changelog is truncated and lists no concrete breaking changes.
export const HOIST_AMBIGUOUS_CHANGELOG = `## 2.0.0
See the migration guide for details. Various internal changes and`
