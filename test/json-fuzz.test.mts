/**
 * @file Property/fuzz tests for src/json.mts (Tier-1 fast-check).
 *   This module is an untrusted-input boundary: it repairs / extracts JSON from
 *   the free-form text a small on-device model emits. The load-bearing claims:
 *
 *   - repairJson(raw): NEVER throws, always returns a string, and extracts the
 *     first balanced `{...}` object (or `{}` when none exists).
 *   - findCanonicalKey / normalizeKeys: rename synonymous keys; an empty synonym
 *     map is the identity; unknown keys pass through untouched.
 *   - mergePrefill(prefill, raw): result is ALWAYS either `raw` or `prefill+raw`.
 *   - buildPrefixedMessages: a total, shape-preserving constructor.
 *   - parseJsonWithFallback: recovers the embedded object from noisy / fenced
 *     text and applies synonym normalization. Arbitraries are CONSTRUCTED so
 *     the expected outcome is known up front — the only oracle used is the
 *     platform JSON.parse, which is the reference the SUT legitimately
 *     delegates to.
 */

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  buildPrefixedMessages,
  findCanonicalKey,
  mergePrefill,
  normalizeKeys,
  parseJsonWithFallback,
  repairJson,
} from '../src/json.mts'

import { identitySchema } from './_shared/identity-schema.mts'

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

// A lowercase word — the alphabet for synonym-map keys. Letters-only means a
// token prefixed with a digit can never collide with one of these.
const word = fc
  .array(fc.constantFrom(...LETTERS), { minLength: 1, maxLength: 8 })
  .map(chars => chars.join(''))

// String content with NO braces / quotes / backslashes, so it survives inside a
// JSON string without adding `{`/`}` that would confuse brace-balance counting.
const braceFreeStr = fc
  .array(fc.constantFrom(...`${LETTERS} 0123456789.-_`), { maxLength: 10 })
  .map(chars => chars.join(''))

// A JSON value whose object keys are brace-free words and whose strings carry no
// braces. Round-trips exactly through JSON.stringify -> parse and never injects
// a stray `{`/`}` into a string literal.
const safeNode = fc.letrec<{ node: unknown }>(tie => ({
  node: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    // oxlint-disable-next-line socket/prefer-undefined-over-null -- null is a JSON value under test
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    braceFreeStr,
    fc.array(tie('node'), { maxLength: 4 }),
    fc.dictionary(word, tie('node'), { maxKeys: 4, noNullPrototype: true }),
  ),
})).node

// Top-level must be an object so the serialized form starts with `{` — that is
// what repairJson keys off of.
const safeObject = fc.dictionary(word, safeNode, {
  maxKeys: 5,
  noNullPrototype: true,
})

// Free text that carries no `{` (so it can't start a JSON object early) and no
// backtick (so it can't form a markdown code fence). It always contains at
// least one letter, so the whole string is never itself valid JSON — forcing
// the repair/extract path.
const noiseText = fc
  .array(fc.constantFrom(...`${LETTERS} 0123456789.}`), { maxLength: 12 })
  .map(chars => `x${chars.join('')}`)

describe('json/repairJson (fuzz)', () => {
  // Never-throws + invariant: on ANY string, returns a string that parses as a
  // JSON object (repairJson's whole contract is to hand JSON.parse something).
  test('never throws and returns a parseable object string', () => {
    fc.assert(
      fc.property(fc.string(), raw => {
        let out = ''
        let threw = false
        try {
          out = repairJson(raw)
        } catch {
          threw = true
        }
        expect(threw).toBe(false)
        expect(typeof out).toBe('string')
        // The extracted slice is a balanced object; when nothing is found the
        // documented fallback is the empty object `{}`.
        expect(out.startsWith('{')).toBe(true)
        expect(out.endsWith('}')).toBe(true)
      }),
    )
  })

  // Oracle (derived-from-input): a well-formed object embedded in brace-free /
  // fence-free noise is extracted verbatim, so JSON.parse recovers the original.
  test('extracts the embedded object from surrounding noise', () => {
    fc.assert(
      fc.property(noiseText, safeObject, fc.string(), (prefix, obj, suffix) => {
        const objStr = JSON.stringify(obj)
        const recovered = repairJson(prefix + objStr + suffix)
        expect(JSON.parse(recovered)).toStrictEqual(obj)
      }),
    )
  })

  // Restricted-input: no `{` anywhere means the fallback empty object.
  test('returns {} when there is no opening brace', () => {
    const noBrace = fc
      .array(fc.constantFrom(...`${LETTERS} 0123456789}`), { maxLength: 20 })
      .map(chars => chars.join(''))
    fc.assert(
      fc.property(noBrace, raw => {
        expect(repairJson(raw)).toBe('{}')
      }),
    )
  })
})

describe('json/findCanonicalKey (fuzz)', () => {
  // A synonym map built from a set of DISTINCT lowercase tokens: element 0 is
  // the canonical, the rest are its synonyms. Uniqueness guarantees no
  // ambiguous mapping.
  const mapArb = fc
    .uniqueArray(word, { minLength: 2, maxLength: 6 })
    .map(tokens => {
      const canonical = tokens[0]!
      const synonyms = tokens.slice(1)
      return {
        canonical,
        map: { [canonical]: synonyms },
        synonyms,
      }
    })

  // Oracle: the canonical maps to itself; every synonym maps to the canonical;
  // matching is case-insensitive.
  test('resolves canonical and synonyms (case-insensitive) to the canonical', () => {
    fc.assert(
      fc.property(mapArb, ({ canonical, map, synonyms }) => {
        expect(findCanonicalKey(canonical, map)).toBe(canonical)
        expect(findCanonicalKey(canonical.toUpperCase(), map)).toBe(canonical)
        for (const synonym of synonyms) {
          expect(findCanonicalKey(synonym, map)).toBe(canonical)
          expect(findCanonicalKey(synonym.toUpperCase(), map)).toBe(canonical)
        }
      }),
    )
  })

  // Restricted-input: a key absent from the map passes through unchanged. The
  // digit prefix guarantees it never equals a letters-only map token.
  test('passes through keys that are not in the map', () => {
    fc.assert(
      fc.property(mapArb, word, ({ map }, extra) => {
        const unrelated = `9${extra}`
        expect(findCanonicalKey(unrelated, map)).toBe(unrelated)
      }),
    )
  })
})

describe('json/normalizeKeys (fuzz)', () => {
  // Identity: with an empty synonym map, normalizeKeys is a structure-preserving
  // deep clone of any safe JSON value.
  test('is the identity under an empty synonym map', () => {
    fc.assert(
      fc.property(safeNode, value => {
        expect(normalizeKeys(value, {})).toStrictEqual(value)
      }),
    )
  })

  // Derived-from-input: a synonym key at the top level is renamed to its
  // canonical while the value is preserved.
  test('renames a synonym key to its canonical', () => {
    const renameArb = fc
      .uniqueArray(word, { maxLength: 2, minLength: 2 })
      .chain(tokens =>
        braceFreeStr.map(value => ({
          canonical: tokens[0]!,
          synonym: tokens[1]!,
          value,
        })),
      )
    fc.assert(
      fc.property(renameArb, ({ canonical, synonym, value }) => {
        const input = { [synonym]: value }
        const map = { [canonical]: [synonym] }
        expect(normalizeKeys(input, map)).toStrictEqual({ [canonical]: value })
      }),
    )
  })

  // Primitives (and null/undefined) are returned untouched regardless of map.
  test('returns primitives unchanged', () => {
    const primitive = fc.oneof(
      fc.integer(),
      fc.boolean(),
      braceFreeStr,
      // oxlint-disable-next-line socket/prefer-undefined-over-null -- null is an input under test
      fc.constant(null),
      fc.constant(undefined),
    )
    fc.assert(
      fc.property(primitive, word, (value, canonical) => {
        expect(normalizeKeys(value, { [canonical]: ['x'] })).toStrictEqual(
          value,
        )
      }),
    )
  })
})

describe('json/mergePrefill (fuzz)', () => {
  // Invariant: the result is ALWAYS one of exactly two constructions.
  test('always returns either raw or prefill+raw', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (prefill, raw) => {
        const merged = mergePrefill(prefill, raw)
        const joined = prefill + raw
        expect(merged === raw || merged === joined).toBe(true)
      }),
    )
  })

  // Restricted-input: when raw already begins (after trimStart) with `{` or `[`
  // the model produced its own JSON, so mergePrefill returns it verbatim.
  test('returns raw untouched when it already opens a JSON value', () => {
    const opener = fc.constantFrom('{', '[')
    fc.assert(
      fc.property(fc.string(), opener, braceFreeStr, (prefill, open, rest) => {
        const raw = open + rest
        expect(mergePrefill(prefill, raw)).toBe(raw)
      }),
    )
  })

  // Derived-from-input: when the prefill is NOT already present and raw does not
  // open a JSON value, mergePrefill glues them. Constructed so raw (lowercase,
  // non-bracket) can never start with the uppercase prefill.
  test('prepends the prefill when it is missing', () => {
    const upperPrefill = fc
      .array(fc.constantFrom(...LETTERS.toUpperCase()), {
        maxLength: 8,
        minLength: 1,
      })
      .map(chars => chars.join(''))
    fc.assert(
      fc.property(upperPrefill, word, (prefill, raw) => {
        expect(mergePrefill(prefill, raw)).toBe(prefill + raw)
      }),
    )
  })
})

describe('json/buildPrefixedMessages (fuzz)', () => {
  // Invariant: total constructor — 2 messages without a system prompt, 3 with
  // one; roles and contents are placed deterministically.
  test('builds a well-shaped message array', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.option(fc.string(), { nil: undefined }),
        (userContent, prefill, systemPrompt) => {
          const messages = buildPrefixedMessages(
            userContent,
            prefill,
            systemPrompt,
          )
          const expectedLength = systemPrompt === undefined ? 2 : 3
          expect(messages).toHaveLength(expectedLength)
          const last = messages[messages.length - 1]!
          expect(last.role).toBe('assistant')
          expect(last.content).toBe(prefill)
          const userMsg = messages.find(m => m.role === 'user')!
          expect(userMsg.content).toBe(userContent)
          if (systemPrompt !== undefined) {
            expect(messages[0]!.role).toBe('system')
            expect(messages[0]!.content).toBe(systemPrompt)
          }
        },
      ),
    )
  })
})

describe('json/parseJsonWithFallback (fuzz)', () => {
  // Oracle: a well-formed object, even when buried in leading noise and trailing
  // junk, is recovered via the repair fallback.
  test('recovers an object embedded in noisy text', () => {
    fc.assert(
      fc.property(noiseText, safeObject, fc.string(), (prefix, obj, suffix) => {
        const raw = `${prefix} ${JSON.stringify(obj)}${suffix}`
        expect(
          parseJsonWithFallback(raw, identitySchema, undefined),
        ).toStrictEqual(obj)
      }),
    )
  })

  // Round-trip: a value wrapped in a ```json code fence is unwrapped and parsed.
  test('unwraps a fenced JSON object', () => {
    fc.assert(
      fc.property(safeObject, obj => {
        const raw = `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``
        expect(
          parseJsonWithFallback(raw, identitySchema, undefined),
        ).toStrictEqual(obj)
      }),
    )
  })

  // Derived-from-input: synonym normalization is applied to the parsed object.
  test('applies synonym normalization to the parsed object', () => {
    const renameArb = fc
      .uniqueArray(word, { maxLength: 2, minLength: 2 })
      .chain(tokens =>
        braceFreeStr.map(value => ({
          canonical: tokens[0]!,
          synonym: tokens[1]!,
          value,
        })),
      )
    fc.assert(
      fc.property(renameArb, ({ canonical, synonym, value }) => {
        const raw = JSON.stringify({ [synonym]: value })
        const map = { [canonical]: [synonym] }
        expect(parseJsonWithFallback(raw, identitySchema, map)).toStrictEqual({
          [canonical]: value,
        })
      }),
    )
  })
})
