/**
 * @file Browser entry point. Exports the backend registry, the Prompt API
 *   adapter, task helpers, and everything needed to call an on-device model
 *   from a content script or extension service worker.
 */

import { probeAvailability } from './availability.mts'
import {
  createAppleFmBackend,
  ODAI_APPLE_FM_SHIM_ENV_VAR,
} from './backends/apple-fm.mts'
import { createGeminiNanoHeadlessBackend } from './backends/gemini-nano-headless.mts'
import {
  createLlamaServerBackend,
  DEFAULT_LLAMA_URL,
  ODAI_LLAMA_MODEL_ENV_VAR,
  ODAI_LLAMA_URL_ENV_VAR,
} from './backends/llama-server.mts'
import {
  backendNames,
  createBackend,
  defaultProbeOrder,
  ODAI_BACKEND_ENV_VAR,
  selectBackend,
} from './backends/registry.mts'
import { createSimulatorBackend } from './backends/simulator.mts'
import { createWindowsPhiSilicaBackend } from './backends/windows-phi-silica.mts'
import { createGeminiNanoModel, createOdaiModel } from './model.mts'
import { classifyDependencyChange } from './tasks/classify-deps.mts'
import {
  installLanguageModelSimulator,
  LanguageModelSessionSimulator,
  LanguageModelSimulator,
} from './simulator.mts'
import { suggestCommitMessage } from './tasks/commit.mts'
import { dedupeDependencies } from './tasks/dedupe.mts'
import { reasonAboutLockfile } from './tasks/lockfile.mts'
import { generateCodePatch } from './tasks/patch.mts'
import { summarizeText } from './tasks/summarize.mts'
import { triageAlerts } from './tasks/triage.mts'

export {
  backendNames,
  classifyDependencyChange,
  createAppleFmBackend,
  createBackend,
  createGeminiNanoHeadlessBackend,
  createGeminiNanoModel,
  createLlamaServerBackend,
  createOdaiModel,
  createSimulatorBackend,
  createWindowsPhiSilicaBackend,
  dedupeDependencies,
  DEFAULT_LLAMA_URL,
  defaultProbeOrder,
  generateCodePatch,
  installLanguageModelSimulator,
  LanguageModelSimulator,
  LanguageModelSessionSimulator,
  ODAI_APPLE_FM_SHIM_ENV_VAR,
  ODAI_BACKEND_ENV_VAR,
  ODAI_LLAMA_MODEL_ENV_VAR,
  ODAI_LLAMA_URL_ENV_VAR,
  probeAvailability,
  reasonAboutLockfile,
  selectBackend,
  suggestCommitMessage,
  summarizeText,
  triageAlerts,
}

export type { AvailabilityResult } from './availability.mts'
export type { AppleFmBackendOptions } from './backends/apple-fm.mts'
export type { LlamaServerBackendOptions } from './backends/llama-server.mts'
export type { SelectBackendOptions } from './backends/registry.mts'
export type { WindowsPhiSilicaBackendOptions } from './backends/windows-phi-silica.mts'
export type {
  BackendAvailability,
  BackendName,
  OdaiBackend,
} from './backends/types.mts'
export type {
  CreateOdaiModelOptions,
  GeminiNanoModel,
  OdaiModel,
} from './model.mts'
export type { CreateSessionOptions } from './session.mts'
export type { StreamOptions } from './stream.mts'
export type { DepClassification } from './prompts/classify-deps.mts'
export type { CommitMessage } from './prompts/commit.mts'
export type { CodePatch } from './prompts/patch.mts'
export type { DedupeResult } from './prompts/dedupe.mts'
export type { LockfileReasoning } from './prompts/lockfile.mts'
export type { TextSummary } from './prompts/summarize.mts'
export type { AlertTriage } from './prompts/triage.mts'
export type {
  LanguageModelState,
  Message,
  PromptOptions,
  SchemaLike,
  SessionLike,
  StructuredPromptOptions,
  TaskResult,
} from './types.mts'
