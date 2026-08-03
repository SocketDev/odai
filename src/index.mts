/**
 * @file Browser entry point. Exports the backend registry, the Prompt API
 *   adapter, task helpers, and everything needed to call an on-device model
 *   from a content script or extension service worker.
 */

import { probeAvailability } from './availability.mts'
import { majorityResult } from './best-of-n.mts'
import {
  createAppleFmBackend,
  ODAI_APPLE_FM_SHIM_ENV_VAR,
} from './backends/apple-fm.mts'
import { createChromeBuiltinBackend } from './backends/chrome-builtin.mts'
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
import {
  CONTROL_TOKENS,
  formatControlTokens,
  parseControlTokens,
} from './control-tokens.mts'
import { detectModelName, matchModelName } from './model-identity.mts'
import { createBuiltinModel, createOdaiModel } from './model.mts'
import {
  createLocalLanguageModelFactory,
  isLanguageModelFactory,
} from './provider.mts'
import { classifyDependencyChange } from './tasks/classify-deps.mts'
import {
  installLanguageModelSimulator,
  LanguageModelSessionSimulator,
  LanguageModelSimulator,
} from './simulator.mts'
import { suggestCommitMessage } from './tasks/commit.mts'
import { dedupeDependencies } from './tasks/dedupe.mts'
import { assessHoistSafety, decideHoistVerdict } from './tasks/hoist.mts'
import { reasonAboutLockfile } from './tasks/lockfile.mts'
import { generateCodePatch } from './tasks/patch.mts'
import { assessSecurityFix, decideSecurityFix } from './tasks/security-fix.mts'
import { summarizeText } from './tasks/summarize.mts'
import { triageAlerts } from './tasks/triage.mts'
import { decideWeeklyUpdate, planWeeklyUpdate } from './tasks/weekly-update.mts'

export {
  backendNames,
  CONTROL_TOKENS,
  detectModelName,
  formatControlTokens,
  matchModelName,
  parseControlTokens,
  classifyDependencyChange,
  assessHoistSafety,
  assessSecurityFix,
  createAppleFmBackend,
  createBackend,
  createBuiltinModel,
  createChromeBuiltinBackend,
  createLlamaServerBackend,
  createLocalLanguageModelFactory,
  createOdaiModel,
  createSimulatorBackend,
  createWindowsPhiSilicaBackend,
  decideHoistVerdict,
  decideSecurityFix,
  decideWeeklyUpdate,
  dedupeDependencies,
  DEFAULT_LLAMA_URL,
  defaultProbeOrder,
  generateCodePatch,
  installLanguageModelSimulator,
  isLanguageModelFactory,
  LanguageModelSimulator,
  LanguageModelSessionSimulator,
  majorityResult,
  ODAI_APPLE_FM_SHIM_ENV_VAR,
  ODAI_BACKEND_ENV_VAR,
  ODAI_LLAMA_MODEL_ENV_VAR,
  ODAI_LLAMA_URL_ENV_VAR,
  planWeeklyUpdate,
  probeAvailability,
  reasonAboutLockfile,
  selectBackend,
  suggestCommitMessage,
  summarizeText,
  triageAlerts,
}

export type { AvailabilityResult } from './availability.mts'
export type {
  BatchEntry,
  BatchResultLine,
  BatchTaskCommand,
} from './cli/batch.mts'
export type { HoistAssessOptions } from './tasks/hoist.mts'
export type { SecurityFixAssessOptions } from './tasks/security-fix.mts'
export type { WeeklyUpdatePlanOptions } from './tasks/weekly-update.mts'
export type {
  LanguageModelAvailability,
  LanguageModelFactory,
} from './provider.mts'
export type { AppleFmBackendOptions } from './backends/apple-fm.mts'
export type { LlamaServerBackendOptions } from './backends/llama-server.mts'
export type { SelectBackendOptions } from './backends/registry.mts'
export type { WindowsPhiSilicaBackendOptions } from './backends/windows-phi-silica.mts'
export type {
  BackendAvailability,
  BackendName,
  OdaiBackend,
} from './backends/types.mts'
export type { CreateOdaiModelOptions, OdaiModel } from './model.mts'
export type { ModelIdentity } from './model-identity.mts'
export type { CreateSessionOptions } from './session.mts'
export type { StreamOptions } from './stream.mts'
export type { DepClassification } from './prompts/classify-deps.mts'
export type { CommitMessage } from './prompts/commit.mts'
export type { CodePatch } from './prompts/patch.mts'
export type { DedupeResult } from './prompts/dedupe.mts'
export type {
  HoistAssessment,
  HoistBreakingChange,
  HoistExtraction,
  HoistInput,
} from './prompts/hoist.mts'
export type { LockfileReasoning } from './prompts/lockfile.mts'
export type {
  SecurityFixAssessment,
  SecurityFixExtraction,
  SecurityFixInput,
} from './prompts/security-fix.mts'
export type { TextSummary } from './prompts/summarize.mts'
export type { AlertTriage } from './prompts/triage.mts'
export type {
  WeeklyUpdateCandidate,
  WeeklyUpdateExtraction,
  WeeklyUpdateInput,
  WeeklyUpdatePlan,
} from './prompts/weekly-update.mts'
export type {
  LanguageModelState,
  Message,
  PromptOptions,
  SchemaLike,
  SessionLike,
  StructuredPromptOptions,
  TaskResult,
} from './types.mts'
