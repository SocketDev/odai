/**
 * @file Resolve an Anthropic API key from every place the fleet might already
 *   hold one, in the order an operator would expect.
 *
 *   THE PROBLEM THIS SOLVES. Claude Code signs in with an OAuth token that
 *   expires. When it expires the client cannot renew it on its own and has no
 *   configured fallback, so the session wedges: every turn fails with an auth
 *   error and no amount of retrying inside the session helps. Meanwhile the
 *   same machine usually holds a perfectly good Anthropic API key, because
 *   OpenCode asked for one at login and stored it.
 *
 *   Claude Code's `apiKeyHelper` setting is the sanctioned way out. It names a
 *   command; the client runs it and uses what it prints as the API key. This
 *   module is the resolution behind that command.
 *
 *   ORDER, AND WHY. Environment first, because an operator who exported a key
 *   for this shell meant that key for this shell. The fleet's own keychain
 *   slot second, because it was set deliberately. OpenCode's store last,
 *   because it is a convenience: it is whatever that tool happened to be
 *   logged in as, which is the right default and the wrong override.
 */

import process from 'node:process'

import { readOpencodeApiKey } from './opencode-auth.mts'
import { CREDENTIAL_SLOTS, readCredential } from './provider-credentials.mts'

/**
 * The provider key OpenCode files an Anthropic credential under.
 */
export const OPENCODE_ANTHROPIC_PROVIDER = 'anthropic'

/**
 * Where a resolved key came from.
 *
 * Reported so a status line can say WHICH source answered without printing
 * the key itself. An operator debugging a wedged client needs to know the
 * helper found something and where, and that is the whole of it.
 */
export type AnthropicKeySource = 'env' | 'keychain' | 'opencode'

export interface ResolvedAnthropicKey {
  readonly key: string
  readonly source: AnthropicKeySource
}

/**
 * Whether a string looks like an Anthropic API key.
 *
 * A shape check, not a validation: only Anthropic can say whether a key works.
 * It exists to stop an empty string, a placeholder, or an OAuth token from
 * being handed to a client as an API key, because each of those produces a
 * confusing auth error instead of an obvious "no key here".
 */
export function looksLikeAnthropicApiKey(value: string): boolean {
  return value.startsWith('sk-ant-') && value.length > 20
}

/**
 * The first Anthropic API key any source offers, with its origin.
 *
 * Undefined when no source has one. A source holding something that does not
 * look like a key is SKIPPED rather than returned, so a stale OAuth token in
 * the environment does not shadow a good key in the keychain.
 */
export async function resolveAnthropicApiKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedAnthropicKey | undefined> {
  const fromEnv = env[CREDENTIAL_SLOTS.anthropicApiKey.envVar]
  if (fromEnv && looksLikeAnthropicApiKey(fromEnv)) {
    return { key: fromEnv, source: 'env' }
  }
  const fromKeychain = await readCredential('anthropicApiKey')
  if (fromKeychain && looksLikeAnthropicApiKey(fromKeychain)) {
    return { key: fromKeychain, source: 'keychain' }
  }
  const fromOpencode = readOpencodeApiKey(OPENCODE_ANTHROPIC_PROVIDER)
  if (fromOpencode && looksLikeAnthropicApiKey(fromOpencode)) {
    return { key: fromOpencode, source: 'opencode' }
  }
  return undefined
}

/**
 * Which sources currently hold a usable key, by name.
 *
 * Never returns a key. Built for a diagnostic that answers "would the helper
 * find anything?" without putting a secret on a terminal that is probably
 * being recorded.
 */
export async function anthropicKeySources(
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly AnthropicKeySource[]> {
  const out: AnthropicKeySource[] = []
  const fromEnv = env[CREDENTIAL_SLOTS.anthropicApiKey.envVar]
  if (fromEnv && looksLikeAnthropicApiKey(fromEnv)) {
    out.push('env')
  }
  const fromKeychain = await readCredential('anthropicApiKey')
  if (fromKeychain && looksLikeAnthropicApiKey(fromKeychain)) {
    out.push('keychain')
  }
  const fromOpencode = readOpencodeApiKey(OPENCODE_ANTHROPIC_PROVIDER)
  if (fromOpencode && looksLikeAnthropicApiKey(fromOpencode)) {
    out.push('opencode')
  }
  return out
}
