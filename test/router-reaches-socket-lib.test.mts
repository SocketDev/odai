// socket-lint: mirror-exempt — end-to-end router proof spanning provider.mts and the simulator backend by design; no single unit under test.
/**
 * @file End-to-end proof that socket-lib's availability-gated tier router reaches
 *   odai as the keyless-local rung and completes a real generation round-trip.
 *   The scenario is a Socket dev machine with NOTHING keyed and NO agent CLI on
 *   PATH: `RouteContext.keyed` and `RouteContext.available` are both empty. The
 *   only usable engine is the keyless on-device tail rung, which socket-lib's
 *   `spawn-local` seam drives through an injected `LocalAgentProvider`. odai is
 *   that provider — its `createLocalLanguageModelFactory` returns exactly the
 *   `@socketsecurity/lib/ai/builtin` `LanguageModelFactory` shape the seam
 *   expects, here backed by the hermetic `simulator` backend so the completion
 *   is deterministic (no Chrome, no llama-server).
 *   Dependency direction stays one-way: this test imports socket-lib's router
 *   (`ai/route`, `ai/spawn`, `ai/spawn-local`) and odai's factory; socket-lib
 *   never imports odai.
 *   Proof surface: (1) `resolveTier` picks the `local` candidate with reason
 *   `fell-over`, and (2) `spawnTierWithFallback` returns a normal
 *   `AgentSpawnResult` carrying the canned completion on stdout.
 */

import { describe, expect, it } from 'vitest'

import { resolveTier } from '@socketsecurity/lib/ai/route'
import { spawnTierWithFallback } from '@socketsecurity/lib/ai/spawn'
import { isLocalEngineAvailable } from '@socketsecurity/lib/ai/spawn-local'

import { createSimulatorBackend } from '../src/backends/simulator.mts'
import { createLocalLanguageModelFactory } from '../src/provider.mts'

import type { LanguageModelFactory } from '../src/provider.mts'
import type { SessionLike } from '../src/types.mts'
import type { RouteContext } from '@socketsecurity/lib/ai/route'
import type {
  LocalAgentProvider,
  LocalSpawnOptions,
} from '@socketsecurity/lib/ai/spawn-local'

// Adapt odai's `LanguageModelFactory` (a `Message[]` session shape) to
// socket-lib's `LocalAgentProvider` (a plain-string `generate`). This is the
// glue a real caller writes when injecting odai into the local rung: probe
// availability through the factory, then wrap the prompt in odai's `Message[]`
// turn shape before handing it to the session.
function odaiLocalAgentProvider(
  factory: LanguageModelFactory,
): LocalAgentProvider {
  return {
    availability: () => factory.availability(),
    async generate(options: LocalSpawnOptions): Promise<string> {
      const session = (await factory.create(
        options.model ? { model: options.model } : undefined,
      )) as SessionLike
      return session.prompt([{ content: options.prompt, role: 'user' }])
    },
  }
}

const CANNED = '{"risk":"low","summary":"router reached odai simulator"}'

async function buildContext(): Promise<{
  ctx: RouteContext
  provider: LocalAgentProvider
}> {
  const factory = createLocalLanguageModelFactory({
    backend: createSimulatorBackend({ fallback: CANNED }),
  })
  const provider = odaiLocalAgentProvider(factory)
  const ctx: RouteContext = {
    // No agent CLI installed and no keyed credentials: the grunt-tier head
    // (Claude) and its CLI ladder (Codex, opencode) are all unusable.
    available: new Set(),
    keyed: new Set(),
    // Probed once through odai's factory, exactly as a caller would.
    localAvailable: await isLocalEngineAvailable(provider),
  }
  return { ctx, provider }
}

const spawnOptions = {
  cwd: process.cwd(),
  disallow: [] as readonly string[],
  permissionMode: 'dontAsk' as const,
  prompt: 'Summarize the dependency change.',
  tools: [] as readonly string[],
}

describe('socket-lib router reaches odai as the keyless-local tier', () => {
  it('probes odai as available for the local rung', async () => {
    const { ctx } = await buildContext()
    expect(ctx.localAvailable).toBe(true)
  })

  for (const tier of ['haiku', 'fable'] as const) {
    it(`resolveTier("${tier}") falls over to the local odai candidate`, async () => {
      const { ctx } = await buildContext()
      const resolution = resolveTier(tier, ctx)
      expect(resolution).toBeDefined()
      expect(resolution!.candidate.kind).toBe('local')
      expect(resolution!.candidate.engine).toBe('builtin')
      expect(resolution!.candidate.provider).toBe('local')
      // The head (Claude) was unusable, so the tail local rung is a fall-over,
      // and the originally-requested tier is echoed back.
      expect(resolution!.reason).toBe('fell-over')
      expect(resolution!.requestedTier).toBe(tier)
    })

    it(`spawnTierWithFallback("${tier}") drives odai and returns a completion`, async () => {
      const { ctx, provider } = await buildContext()
      const spawn = await spawnTierWithFallback(
        tier,
        ctx,
        spawnOptions,
        provider,
      )
      // The local rung was reached directly — no CLI candidate was usable to
      // fall over from.
      expect(spawn.candidate.kind).toBe('local')
      expect(spawn.fellOver).toHaveLength(0)
      // A normal AgentSpawnResult carrying odai's completion round-trip.
      expect(spawn.result.exitCode).toBe(0)
      expect(spawn.result.unavailable).toBe(false)
      expect(spawn.result.overloaded).toBe(false)
      expect(spawn.result.attempts).toBe(1)
      expect(spawn.result.stdout).toBe(CANNED)
    })
  }

  it('reaches nothing when the local engine is also unavailable', async () => {
    // With no keyed provider, no CLI, AND the local engine down, the grunt
    // chain has no usable rung: resolveTier returns undefined and the spawn
    // orchestrator throws rather than silently degrading.
    const ctx: RouteContext = {
      available: new Set(),
      keyed: new Set(),
      localAvailable: false,
    }
    expect(resolveTier('haiku', ctx)).toBeUndefined()
    await expect(
      spawnTierWithFallback('haiku', ctx, spawnOptions),
    ).rejects.toThrow(/no usable agent/)
  })
})
