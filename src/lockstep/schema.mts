import { Type } from '@sinclair/typebox'
import type { Static } from '@sinclair/typebox'

const pathSchema = Type.String({ minLength: 1, maxLength: 512 })
const shaSchema = Type.String({ pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' })
const lineSchema = Type.Integer({ minimum: 1, maximum: 10_000_000 })
const areasSchema = Type.Array(pathSchema, {
  minItems: 1,
  maxItems: 16,
  uniqueItems: true,
})

export const LockstepInputSchema = Type.Object(
  {
    version: Type.Literal(1),
    row: Type.Object(
      {
        id: Type.String({ minLength: 1, maxLength: 128 }),
        kind: Type.Union([
          Type.Literal('file-fork'),
          Type.Literal('version-pin'),
          Type.Literal('feature-parity'),
          Type.Literal('spec-conformance'),
          Type.Literal('lang-parity'),
        ]),
        materialization: Type.Union([
          Type.Literal('full'),
          Type.Literal('sparse'),
        ]),
        upstream: Type.String({ minLength: 1, maxLength: 128 }),
        baseSha: shaSchema,
        targetSha: shaSchema,
        localAreas: areasSchema,
        testAreas: areasSchema,
        deviations: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
          maxItems: 32,
        }),
        sparseCone: Type.Array(pathSchema, { maxItems: 32, uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
    evidence: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 128 }),
          side: Type.Union([
            Type.Literal('upstream'),
            Type.Literal('local'),
            Type.Literal('test'),
          ]),
          path: pathSchema,
          sha: shaSchema,
          startLine: lineSchema,
          text: Type.String({ minLength: 1, maxLength: 12_000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 48 },
    ),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
)

export const LockstepAnalysisSchema = Type.Object(
  {
    verdict: Type.Union([
      Type.Literal('port'),
      Type.Literal('no-change'),
      Type.Literal('abstain'),
    ]),
    facts: Type.Array(
      Type.Object(
        {
          description: Type.String({ minLength: 1, maxLength: 2000 }),
          evidenceId: Type.String({ minLength: 1, maxLength: 128 }),
          startLine: lineSchema,
          endLine: lineSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
    patches: Type.Array(
      Type.Object(
        {
          path: pathSchema,
          patch: Type.String({ minLength: 1, maxLength: 32_768 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 16 },
    ),
    questions: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
      maxItems: 16,
    }),
  },
  { additionalProperties: false },
)

export const LockstepProposalSchema = Type.Object(
  {
    verdict: Type.Union([
      Type.Literal('port'),
      Type.Literal('no-change'),
      Type.Literal('abstain'),
    ]),
    facts: LockstepAnalysisSchema.properties.facts,
    changes: Type.Array(
      Type.Object(
        {
          path: pathSchema,
          evidenceId: Type.String({ minLength: 1, maxLength: 128 }),
          startLine: lineSchema,
          endLine: lineSchema,
          operation: Type.Union([
            Type.Literal('replace'),
            Type.Literal('append'),
          ]),
          text: Type.String({ minLength: 1, maxLength: 32_768 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 16 },
    ),
    questions: LockstepAnalysisSchema.properties.questions,
  },
  { additionalProperties: false },
)

export type LockstepInput = Static<typeof LockstepInputSchema>
export type LockstepAnalysis = Static<typeof LockstepAnalysisSchema>
export type LockstepProposal = Static<typeof LockstepProposalSchema>
