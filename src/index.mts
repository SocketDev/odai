/**
 * @file Browser entry point. Exports the backend registry, the Prompt API
 *   adapter, task helpers, and everything needed to call an on-device model
 *   from a content script or extension service worker.
 */

import { probeAvailability } from './availability.mts'
import { createAppleFmBackend } from './backends/apple-fm.mts'
import { createGeminiNanoHeadlessBackend } from './backends/gemini-nano-headless.mts'
import { createLlamaServerBackend } from './backends/llama-server.mts'
import {
  backendNames,
  createBackend,
  defaultProbeOrder,
  LOCAI_BACKEND_ENV_VAR,
  selectBackend,
} from './backends/registry.mts'
import { createSimulatorBackend } from './backends/simulator.mts'
import { createGeminiNanoModel, createLocaiModel } from './model.mts'
import {
  installLanguageModelSimulator,
  LanguageModelSessionSimulator,
  LanguageModelSimulator,
} from './simulator.mts'
import { dedupeDependencies } from './tasks/dedupe.mts'
import { reasonAboutLockfile } from './tasks/lockfile.mts'
import { generateCodePatch } from './tasks/patch.mts'

export {
  backendNames,
  createAppleFmBackend,
  createBackend,
  createGeminiNanoHeadlessBackend,
  createGeminiNanoModel,
  createLlamaServerBackend,
  createLocaiModel,
  createSimulatorBackend,
  dedupeDependencies,
  defaultProbeOrder,
  generateCodePatch,
  installLanguageModelSimulator,
  LanguageModelSimulator,
  LanguageModelSessionSimulator,
  LOCAI_BACKEND_ENV_VAR,
  probeAvailability,
  reasonAboutLockfile,
  selectBackend,
}

export type { AvailabilityResult } from './availability.mts'
export type { SelectBackendOptions } from './backends/registry.mts'
export type {
  BackendAvailability,
  BackendName,
  LocaiBackend,
} from './backends/types.mts'
export type {
  CreateLocaiModelOptions,
  GeminiNanoModel,
  LocaiModel,
} from './model.mts'
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
