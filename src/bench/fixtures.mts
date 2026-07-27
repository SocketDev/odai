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
