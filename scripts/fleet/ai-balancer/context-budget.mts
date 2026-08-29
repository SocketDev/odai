/**
 * @file Context awareness for the ai-balancer's routing and failover ladder.
 *
 *   The ladder used to pick a rung on role and image capability alone, which
 *   is fine for a small turn and wrong for a large one: a 400k-token
 *   compaction request routed to a 262k seat is a guaranteed
 *   `context_length_exceeded`, and the failover ladder would then walk to the
 *   NEXT seat that also cannot hold it. Every rung 400s, the operator sees
 *   "every provider is rate-limited", and the real answer (one seat on the
 *   ladder has a 1M window) never gets tried.
 *
 *   So the ladder is filtered by capacity BEFORE it is walked. The per-model
 *   window is already recorded in `constants/model-pricing.json`; this module
 *   is the reader that turns it into a routing decision.
 *
 *   FAIL CLOSED ON AN UNKNOWN WINDOW. A model with no recorded window is not
 *   assumed roomy. Under real context pressure an unknown seat is dropped from
 *   the ladder, because sending a huge body to a seat whose ceiling nobody
 *   wrote down is the exact failure this module exists to stop. At low
 *   pressure it is kept, because most turns fit anywhere and dropping every
 *   unpriced seat would empty the ladder.
 */

import {
  PROVIDER_ANTHROPIC,
  PROVIDER_FIREWORKS,
  PROVIDER_OPENAI,
  PROVIDER_SYNTHETIC,
} from '../_shared/offload-spend.mts'
import { findModelPricing, loadPricing } from '../estimate-ai-cost.mts'

import type { PricingData } from '../estimate-ai-cost.mts'

/**
 * Balancer provider id to the service key that owns it in the pricing data.
 *
 * The two namespaces do not match and never will: the balancer's provider is
 * `fireworks-ai` (the OpenCode provider slug) while the pricing service is
 * `fireworks` (the vendor). Mapping here keeps that mismatch in one place
 * instead of a `.replace()` at each call site.
 *
 * odai is absent on purpose. The local llama-server serves whatever model the
 * operator loaded, under whatever id they gave it, so there is no catalog
 * entry to price and no window to look up.
 */
export const PROVIDER_PRICING_SERVICE: Readonly<Record<string, string>> = {
  [PROVIDER_ANTHROPIC]: 'anthropic',
  [PROVIDER_FIREWORKS]: 'fireworks',
  [PROVIDER_OPENAI]: 'openai',
  [PROVIDER_SYNTHETIC]: 'synthetic',
}

/**
 * Tokens held back for the model's own answer.
 *
 * A window is shared by the prompt and the completion. A request that fits the
 * window EXACTLY leaves no room to reply, and the provider rejects it for the
 * same reason it rejects an oversized prompt, so the usable prompt budget is
 * the window minus this.
 */
export const OUTPUT_RESERVE_TOKENS = 32_000

/**
 * The share of a window above which a request counts as under pressure.
 *
 * Below this an unpriced seat is still worth trying. Above it, capacity is the
 * deciding factor and guesswork is not good enough.
 */
export const CONTEXT_PRESSURE_RATIO = 0.6

/**
 * Bytes of request text per token, for the estimate below.
 *
 * The usual four-characters-per-token rule. It is an ESTIMATE and it is meant
 * to be: the exact count depends on the model's own tokenizer, which the
 * balancer does not have and would not want to run per request. Every use of
 * the number here is a comparison against a window with a reserve already
 * subtracted, so a modest error changes nothing.
 */
export const CHARS_PER_TOKEN = 4

/**
 * Tokens an inline image is counted as.
 *
 * A base64 image inflates the serialized body far past what it costs the
 * model, so counting its characters would overstate a screenshot by orders of
 * magnitude and empty the ladder. This is a flat per-image charge instead,
 * sized to a typical full-screen capture.
 */
export const IMAGE_TOKEN_CHARGE = 1_600

/**
 * How much of a model's window a request is asking for.
 */
export interface ContextFit {
  /**
   * Prompt tokens the request is estimated to carry.
   */
  readonly estimatedTokens: number
  /**
   * Whether the estimate fits under the usable budget. True when the window is
   * unknown, so an unpriced seat is not reported as failing a check that was
   * never run - callers read `windowKnown` to tell the two apart.
   */
  readonly fits: boolean
  /**
   * Fraction of the usable budget the request consumes, or undefined when the
   * window is unknown.
   */
  readonly ratio: number | undefined
  /**
   * The model's full context window, when one is recorded.
   */
  readonly window: number | undefined
  /**
   * Whether a window was actually found, as opposed to assumed.
   */
  readonly windowKnown: boolean
}

/**
 * Strip a balancer provider prefix off a model id.
 *
 * The catalog stores provider-qualified ids
 * (`fireworks-ai/accounts/fireworks/models/kimi-k3`) while the pricing data
 * keys the bare vendor id (`accounts/fireworks/models/kimi-k3`). Returns the
 * id unchanged when it carries no known prefix.
 */
export function stripProviderPrefix(modelId: string): string {
  const providers = Object.keys(PROVIDER_PRICING_SERVICE)
  for (let i = 0, { length } = providers; i < length; i += 1) {
    const prefix = `${providers[i]!}/`
    if (modelId.startsWith(prefix)) {
      return modelId.slice(prefix.length)
    }
  }
  return modelId
}

/**
 * The recorded context window for a model, or undefined when the pricing data
 * does not carry one.
 *
 * Tries the id as given, then with its provider prefix stripped, then under
 * the owning service's key. A model that is in the catalog but not in the
 * pricing data - several routers are - answers undefined rather than a guess.
 */
export function contextWindowFor(
  modelId: string,
  pricing: PricingData = loadPricing(),
): number | undefined {
  const candidates = [modelId, stripProviderPrefix(modelId)]
  for (let i = 0, { length } = candidates; i < length; i += 1) {
    const found = findModelPricing(pricing, candidates[i]!)
    const window = found?.model.contextWindow
    if (typeof window === 'number' && window > 0) {
      return window
    }
  }
  return undefined
}

/**
 * Keys whose values are wire-format discriminators, not prompt content.
 *
 * `role: 'assistant'` and `type: 'text'` are structure the client and the
 * provider agree on; the model is not billed for them as prose. Counting them
 * made the estimate drift by a few tokens per message and, worse, made it
 * depend on how many blocks a body happened to be split into. Skipping them
 * keeps the number a function of the actual text.
 */
export const NON_PROMPT_KEYS: ReadonlySet<string> = new Set([
  'encoding',
  'id',
  'media_type',
  'model',
  'role',
  'stop_reason',
  'type',
])

/**
 * Prompt tokens a parsed request body is estimated to carry.
 *
 * Walks the body summing text length, and charges each inline image a flat
 * rate rather than its base64 length. Anything that is not text and not an
 * image contributes nothing, so a body of tool plumbing does not read as a
 * large prompt.
 */
export function estimateBodyTokens(body: unknown): number {
  let chars = 0
  let images = 0

  function walk(node: unknown): void {
    if (typeof node === 'string') {
      chars += node.length
      return
    }
    if (Array.isArray(node)) {
      for (let i = 0, { length } = node; i < length; i += 1) {
        walk(node[i])
      }
      return
    }
    if (node === null || typeof node !== 'object') {
      return
    }
    const record = node as Record<string, unknown>
    // An image block carries its payload in `source.data` as base64. Charge
    // the flat rate and do NOT descend, so the base64 never reaches the
    // character count.
    if (record['type'] === 'image') {
      images += 1
      return
    }
    const keys = Object.keys(record)
    for (let i = 0, { length } = keys; i < length; i += 1) {
      const key = keys[i]!
      if (NON_PROMPT_KEYS.has(key)) {
        continue
      }
      walk(record[key])
    }
  }

  walk(body)
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKEN_CHARGE
}

/**
 * Whether a body is a client's conversation-compaction turn.
 *
 * A compaction turn is the whole session handed back to the model with an
 * instruction to summarise it, so it is both the largest request a session
 * ever sends and the one carrying the most source material. Both facts change
 * routing: it needs the roomiest seat, and it must never reach a seat that
 * trains on prompts.
 *
 * Detected by the instruction the client writes, matched case-insensitively
 * against a small marker list. These are HEURISTICS over another tool's
 * prompt text and can go stale when that tool rewords its prompt, which is
 * why {@link contextFit} pressure is the independent second signal - a
 * compaction turn that no marker catches is still caught as a large request.
 */
export const COMPACTION_MARKERS: readonly string[] = [
  'create a detailed summary of the conversation',
  'summary of the conversation so far',
  'this session is being continued from a previous conversation',
  'continue the conversation from where we left it off',
]

export function isCompactionRequest(body: unknown): boolean {
  let hit = false

  function walk(node: unknown): void {
    if (hit) {
      return
    }
    if (typeof node === 'string') {
      const lower = node.toLowerCase()
      for (let i = 0, { length } = COMPACTION_MARKERS; i < length; i += 1) {
        if (lower.includes(COMPACTION_MARKERS[i]!)) {
          hit = true
          return
        }
      }
      return
    }
    if (Array.isArray(node)) {
      for (let i = 0, { length } = node; i < length; i += 1) {
        walk(node[i])
      }
      return
    }
    if (node === null || typeof node !== 'object') {
      return
    }
    const values = Object.values(node as Record<string, unknown>)
    for (let i = 0, { length } = values; i < length; i += 1) {
      walk(values[i])
    }
  }

  walk(body)
  return hit
}

/**
 * How a request of `estimatedTokens` sits against one model's window.
 */
export function contextFit(
  modelId: string,
  estimatedTokens: number,
  pricing: PricingData = loadPricing(),
): ContextFit {
  const window = contextWindowFor(modelId, pricing)
  if (window === undefined) {
    return {
      estimatedTokens,
      fits: true,
      ratio: undefined,
      window: undefined,
      windowKnown: false,
    }
  }
  // A window smaller than the reserve cannot host any turn with room to
  // answer. Clamp to 1 so the ratio stays finite and the seat reads as full
  // rather than dividing by zero.
  const usable = Math.max(window - OUTPUT_RESERVE_TOKENS, 1)
  return {
    estimatedTokens,
    fits: estimatedTokens <= usable,
    ratio: estimatedTokens / usable,
    window,
    windowKnown: true,
  }
}

/**
 * Whether a request is large enough that capacity decides the route.
 */
export function isUnderContextPressure(
  fit: ContextFit,
  ratio: number = CONTEXT_PRESSURE_RATIO,
): boolean {
  return fit.ratio !== undefined && fit.ratio >= ratio
}

/**
 * A ladder entry this module can rank. Structural on purpose: it matches
 * `FailoverCandidate` without importing it, so failover.mts and proxy.mts can
 * both pass their own shapes through.
 */
export interface ContextRankable {
  readonly model: string
  readonly wireModel: string
}

/**
 * Drop the rungs that cannot hold this request, then put the roomiest first.
 *
 * Order matters more than it looks. The ladder's own order encodes cost and
 * preference, and that order is KEPT for everything that fits, because a
 * request that fits everywhere should still go to the cheap seat. Reordering
 * happens only when the request is large: at that point the cheapest seat that
 * fits is worth less than the one that will not 400 halfway through a
 * compaction.
 *
 * When every rung is dropped the ORIGINAL ladder is returned rather than an
 * empty one. An empty ladder turns into "every provider is rate-limited",
 * which is a worse answer than trying a seat that might be bigger than its
 * pricing row claims.
 */
export function orderLadderByContext<T extends ContextRankable>(
  ladder: readonly T[],
  estimatedTokens: number,
  pricing: PricingData = loadPricing(),
): readonly T[] {
  if (ladder.length === 0) {
    return ladder
  }
  const scored = ladder.map((entry, index) => ({
    entry,
    fit: contextFit(entry.wireModel, estimatedTokens, pricing),
    index,
  }))
  const pressured = scored.some(row => isUnderContextPressure(row.fit))
  const kept = scored.filter(row => {
    if (!row.fit.windowKnown) {
      // Unpriced seat: fine for a small turn, not trusted for a large one.
      return !pressured
    }
    return row.fit.fits
  })
  if (kept.length === 0) {
    return ladder
  }
  if (!pressured) {
    // Small turn: capacity is not the deciding factor, so the ladder's own
    // cost order stands.
    return kept.map(row => row.entry)
  }
  kept.sort((a, b) => {
    const aWindow = a.fit.window ?? 0
    const bWindow = b.fit.window ?? 0
    if (aWindow !== bWindow) {
      return bWindow - aWindow
    }
    return a.index - b.index
  })
  return kept.map(row => row.entry)
}
