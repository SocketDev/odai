/**
 * @file Price-extraction task. The model receives a vendor pricing page plus
 *   the model ids to price and returns per-million-token rates for the ids
 *   the page actually prices. The reply is filtered to the requested ids in
 *   code, so a hallucinated model id can never reach the caller.
 */

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Static } from '@sinclair/typebox'

import {
  createPricingPrompt,
  PRICING_FEW_SHOT,
  PRICING_PREFILL,
  PRICING_SYNONYM_MAP,
  PRICING_SYSTEM_PROMPT,
} from '../prompts/pricing.mts'
import type { PricingExtraction, PricingInput } from '../prompts/pricing.mts'
import type { OdaiModel } from '../model.mts'
import type { TaskResult } from '../types.mts'

export type { PricingExtraction, PricingInput }

const PricingExtractionSchema = Type.Object(
  {
    prices: Type.Record(
      Type.String(),
      Type.Object(
        {
          inputPerMtok: Type.Number(),
          outputPerMtok: Type.Number(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

export async function extractPrices(
  model: OdaiModel,
  input: PricingInput,
): Promise<TaskResult<PricingExtraction>> {
  const requested = new Set(input.models)
  const PricingExtractionSchemaLike = {
    parse(value: unknown): Static<typeof PricingExtractionSchema> {
      const parsed = Value.Parse(PricingExtractionSchema, value)
      // Deterministic guard: only ids the caller asked for survive, however
      // the model read the page.
      const prices: PricingExtraction['prices'] = { __proto__: null } as never
      for (const [id, rate] of Object.entries(parsed.prices)) {
        if (requested.has(id)) {
          prices[id] = rate
        }
      }
      return { prices }
    },
  }
  return model.promptStructured<Static<typeof PricingExtractionSchema>>(
    createPricingPrompt(input),
    {
      initialPrompts: [
        { content: PRICING_SYSTEM_PROMPT, role: 'system' },
        ...PRICING_FEW_SHOT,
      ],
      prefill: PRICING_PREFILL,
      schema: PricingExtractionSchemaLike,
      synonymMap: PRICING_SYNONYM_MAP,
    },
  )
}
