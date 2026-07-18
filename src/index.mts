/**
 * @file Browser entry point. Exports the Prompt API adapter, task helpers, and
 *   everything needed to call on-device Gemini Nano from a content script or
 *   extension service worker.
 */

import { probeAvailability } from './availability.mts'
import { createGeminiNanoModel } from './model.mts'
import {
  installLanguageModelSimulator,
  LanguageModelSessionSimulator,
  LanguageModelSimulator,
} from './simulator.mts'
import { dedupeDependencies } from './tasks/dedupe.mts'
import { reasonAboutLockfile } from './tasks/lockfile.mts'
import { generateCodePatch } from './tasks/patch.mts'

export {
  createGeminiNanoModel,
  dedupeDependencies,
  generateCodePatch,
  installLanguageModelSimulator,
  LanguageModelSimulator,
  LanguageModelSessionSimulator,
  probeAvailability,
  reasonAboutLockfile,
}

export type { AvailabilityResult } from './availability.mts'
export type { GeminiNanoModel } from './model.mts'
export type { CreateSessionOptions } from './session.mts'
export type { StreamOptions } from './stream.mts'
export type { CodePatch } from './prompts/patch.mts'
export type { DedupeResult } from './prompts/dedupe.mts'
export type { LockfileReasoning } from './prompts/lockfile.mts'
export type {
  LanguageModelState,
  Message,
  PromptOptions,
  SchemaLike,
  SessionLike,
  StructuredPromptOptions,
  TaskResult,
} from './types.mts'
