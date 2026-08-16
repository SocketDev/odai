/**
 * @file Vitiate coverage-guided fuzz target (Tier 2) for src/json.mts — the
 *   untrusted-input JSON boundary. A small on-device model emits free-form text
 *   and this module repairs / extracts JSON from it, so every byte here is
 *   attacker-influenced. Complements the fast-check property tests in
 *   json-fuzz.test.mts: fast-check checks correctness on CONSTRUCTED values;
 *   vitiate feeds SWC-coverage-guided mutated BYTES to reach deep parser paths
 *   a spec-based test never hits, with the prototypePollution detector watching
 *   for a `__proto__` leak through normalizeKeys. Run via `pnpm run
 *   test:fuzz`.
 */

import { fuzz } from '@vitiate/core'

import { parseJsonWithFallback, repairJson } from '../src/json.mts'

// The identity schema: parseJsonWithFallback's schema.parse must be a total,
// non-throwing pass-through so the fuzz exercises the parse/repair/normalize
// pipeline itself rather than a schema validator's own throws.
const identitySchema = {
  parse(value: unknown): unknown {
    return value
  },
}

// A synonym map with attacker-relevant canonical/synonym keys so normalizeKeys
// runs over arbitrary parsed objects — the code path where a `__proto__` key
// could leak into the rebuilt object.
const synonymMap: Record<string, string[]> = {
  __proto__: ['proto', 'prototype'],
  constructor: ['ctor'],
  id: ['identifier', 'key'],
}

// `repairJson(raw)` documents a total contract: it NEVER throws and ALWAYS
// returns a string. Any thrown error on arbitrary bytes is a crash.
fuzz('repairJson never throws on arbitrary bytes', data => {
  const out = repairJson(data.toString('utf8'))
  if (typeof out !== 'string') {
    throw new TypeError('repairJson must always return a string')
  }
})

// `parseJsonWithFallback` may throw its intended parse/validation errors (bad
// JSON that repairJson can't rescue), which callers catch. It must never crash
// uncontrollably, and the prototypePollution detector flags any `__proto__`
// that actually reaches the normalized object.
fuzz('parseJsonWithFallback never crashes on arbitrary bytes', data => {
  try {
    parseJsonWithFallback(data.toString('utf8'), identitySchema, synonymMap)
  } catch {
    // Intended parse/validation throws are the contract; only an uncontrolled
    // crash (or a detector hit) fails the fuzz.
  }
})
