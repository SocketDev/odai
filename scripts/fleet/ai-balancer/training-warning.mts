/**
 * @file The warning the balancer raises when it lands a turn on a free rung
 *   that trains on prompts, and the output guard that catches what such a rung
 *   tends to do wrong.
 *
 *   TWO SEPARATE PROBLEMS, ONE FILE, because they share a trigger.
 *
 *   The first is disclosure. `model-training-policy.mts` already BLOCKS a
 *   training seat once a private repo has been read, and that is the right
 *   behaviour when it fires. It says nothing at all in the case it allows:
 *   public-only work failing over onto a free seat. The operator's prompts
 *   then feed someone's training set and the only trace is a routing line that
 *   reads like every other routing line. A switch onto a training rung is a
 *   change in who keeps the text, so it gets said out loud, once per rung.
 *
 *   The second is output drift. A free rung answers in the wrong language -
 *   most often Chinese, from a model whose instruction tuning falls back to
 *   its base distribution under a long or unusual prompt. It is not a
 *   transport failure, so nothing downstream catches it: a fluent answer in
 *   the wrong language streams through as a success. `guardModelOutput` reads
 *   a sample of the text and reports when it is not the language the operator
 *   asked in, and when it violates the fleet's plain-language standard, so the
 *   caller can fail over instead of shipping it.
 */

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { modelTrainsOnData } from '../_shared/model-training-policy.mts'

const logger = getDefaultLogger()

/**
 * Rungs already warned about, so a long session with repeated failovers says
 * it once per rung instead of once per turn.
 *
 * Keyed by `provider/model`: two providers serving the same free model are two
 * separate disclosures, because they are two separate parties keeping the
 * text.
 */
const warnedRungs = new Set<string>()

/**
 * Announce a switch onto a rung that trains on prompts.
 *
 * Returns whether a warning was raised, so a caller can record the switch
 * without re-deriving the condition. A rung that does not train is silent, and
 * so is a repeat of a rung already announced.
 */
export function warnOnTrainingRung(config: {
  readonly from?: string | undefined
  readonly model: string
  readonly provider: string
}): boolean {
  const { from, model, provider } = { __proto__: null, ...config } as {
    from?: string | undefined
    model: string
    provider: string
  }
  if (!modelTrainsOnData(model)) {
    return false
  }
  const key = `${provider}/${model}`
  if (warnedRungs.has(key)) {
    return false
  }
  warnedRungs.add(key)
  logger.warn(
    `ai-balancer: switching${from ? ` from ${from}` : ''} to ${model} via ${provider}, ` +
      'a free rung that TRAINS ON PROMPTS. ' +
      'Saw: this turn is billed at zero and its text may be retained for training; ' +
      'wanted a paid rung when the content is sensitive. ' +
      'Fix: set AI_BALANCER_PRIMARY_PROVIDER to a paid provider for this session, ' +
      'or stop and re-run the turn once a paid rung has quota.',
  )
  return true
}

/**
 * Forget every warned rung. Used by tests, and by a caller that wants the
 * disclosure repeated for a new session.
 */
export function resetTrainingWarnings(): void {
  warnedRungs.clear()
}

/**
 * Which rungs have already been announced, for diagnostics.
 */
export function warnedTrainingRungs(): readonly string[] {
  return Array.from(warnedRungs)
}

/**
 * The scripts whose presence means the answer is not in the language the
 * operator wrote in.
 *
 * Ranges rather than a language detector on purpose. A detector is a
 * dependency, needs a corpus, and answers a harder question than the one being
 * asked. The question here is narrow: did this rung stop answering in the
 * script the prompt used? CJK, Cyrillic, and Arabic each answer that with a
 * codepoint test and no false positive worth worrying about.
 */
export const NON_LATIN_SCRIPTS: readonly {
  readonly name: string
  readonly test: RegExp
}[] = [
  // CJK Unified Ideographs, plus the extension A block. Catches the Chinese
  // fallback this guard was written for, and Japanese kanji with it.
  { name: 'Han', test: /[\u3400-\u4DBF\u4E00-\u9FFF]/ },
  { name: 'Hiragana or Katakana', test: /[\u3040-\u30FF]/ },
  { name: 'Hangul', test: /[\uAC00-\uD7AF]/ },
  { name: 'Cyrillic', test: /[\u0400-\u04FF]/ },
  { name: 'Arabic', test: /[\u0600-\u06FF]/ },
]

/**
 * Share of a sample that may be non-Latin before the answer counts as drifted.
 *
 * Not zero. A correct answer quotes a filename, a test fixture, or a user's
 * own pasted text, and any of those can carry a stray non-Latin character. The
 * failure this catches is an answer written in another script, which runs far
 * above this.
 */
export const SCRIPT_DRIFT_RATIO = 0.05

/**
 * Characters of the answer to read.
 *
 * The whole point is to decide early, before a long answer has streamed to the
 * operator. A drifted answer drifts from its first sentence.
 */
export const OUTPUT_SAMPLE_CHARS = 2_000

/**
 * Phrases the fleet's plain-language standard bans outright, lowercased.
 *
 * A short list, restricted to the tells that a rung swapped register rather
 * than the whole prose doctrine: the full standard is a writing guide for
 * humans and is not enforceable against a streamed token sequence. These are
 * the throat-clearing and filler openers that mark an answer as padded.
 */
export const PADDING_TELLS: readonly string[] = [
  'as an ai language model',
  'certainly! here',
  'great question',
  "i'd be happy to help",
  'i hope this helps',
  'in conclusion,',
  'it is important to note that',
  'let me know if you have any questions',
]

/**
 * What the guard found in a model's answer.
 */
export interface OutputVerdict {
  /**
   * Why the answer was rejected, worded for the operator. Empty when it passed.
   */
  readonly reasons: readonly string[]
  /**
   * The script that dominated the sample, when one did.
   */
  readonly script: string | undefined
  /**
   * Whether the answer is fit to forward.
   */
  readonly usable: boolean
}

/**
 * Read the start of a model's answer and report whether it is usable.
 *
 * `expectLatin` is the caller's claim about the prompt: true when the operator
 * wrote in a Latin script, which is the only case where a non-Latin answer is
 * evidence of drift. A prompt written in Chinese should get an answer in
 * Chinese, and this guard must not fight that.
 */
export function guardModelOutput(config: {
  readonly expectLatin?: boolean | undefined
  readonly text: string
}): OutputVerdict {
  const { expectLatin = true, text } = { __proto__: null, ...config } as {
    expectLatin?: boolean | undefined
    text: string
  }
  const sample = text.slice(0, OUTPUT_SAMPLE_CHARS)
  const reasons: string[] = []
  let script: string | undefined

  if (expectLatin && sample.length > 0) {
    for (let i = 0, { length } = NON_LATIN_SCRIPTS; i < length; i += 1) {
      const entry = NON_LATIN_SCRIPTS[i]!
      const global = new RegExp(entry.test.source, 'gu')
      const hits = sample.match(global)?.length ?? 0
      if (hits / sample.length >= SCRIPT_DRIFT_RATIO) {
        script = entry.name
        reasons.push(
          `the answer is written in ${entry.name}, but the prompt was not. ` +
            'Saw: a rung answering outside the prompt\'s script; wanted the ' +
            'language the operator asked in.',
        )
        break
      }
    }
  }

  const lower = sample.toLowerCase()
  for (let i = 0, { length } = PADDING_TELLS; i < length; i += 1) {
    const tell = PADDING_TELLS[i]!
    if (lower.includes(tell)) {
      reasons.push(
        `the answer opens with padding ("${tell}"), which the fleet's ` +
          'plain-language standard bans.',
      )
      break
    }
  }

  return { reasons, script, usable: reasons.length === 0 }
}

/**
 * The instruction appended to a request bound for a rung known to drift.
 *
 * Cheaper than catching the drift after the fact, and it is the same fix an
 * operator would apply by hand. Kept to one sentence: a long style preamble on
 * a free rung eats the budget the turn needed.
 */
export const PLAIN_LANGUAGE_DIRECTIVE =
  'Answer in the same language as this prompt. ' +
  'Write plainly and concisely for a non-specialist reader: no preamble, no filler, no summary of the request.'

/**
 * Whether a rung should carry {@link PLAIN_LANGUAGE_DIRECTIVE}.
 *
 * The free training rungs are the ones observed to drift, so they are the ones
 * that get the instruction. A paid rung is left alone rather than paying for
 * tokens it does not need.
 */
export function needsPlainLanguageDirective(model: string): boolean {
  return modelTrainsOnData(model)
}
