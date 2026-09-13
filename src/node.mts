/**
 * @file Node entry point for local inference, tasks, and explicit simulators.
 */

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
import { parseBatchManifest, runBatchEntries } from './cli/batch.mts'
import {
  DEFAULT_PROMPT_TIMEOUT_MS,
  EXIT_NO_BACKEND,
  EXIT_OK,
  EXIT_TASK_FAILURE,
  EXIT_USAGE,
  ODAI_TIMEOUT_ENV_VAR,
  runCli,
} from './cli/run.mts'
import { createSimulatorBackend } from './backends/simulator.mts'
import { createWindowsPhiSilicaBackend } from './backends/windows-phi-silica.mts'
import {
  CONTROL_TOKENS,
  formatControlTokens,
  parseControlTokens,
} from './control-tokens.mts'
import { detectModelName, matchModelName } from './model-identity.mts'
import { createOdaiModel } from './model.mts'
import {
  createLocalLanguageModelFactory,
  isLanguageModelFactory,
} from './provider.mts'
import {
  installLanguageModelSimulator,
  LanguageModelSessionSimulator,
  LanguageModelSimulator,
} from './simulator.mts'
import { classifyDependencyChange } from './tasks/classify-deps.mts'
import { suggestCommitMessage } from './tasks/commit.mts'
import { dedupeDependencies } from './tasks/dedupe.mts'
import { assessHoistSafety, decideHoistVerdict } from './tasks/hoist.mts'
import { reasonAboutLockfile } from './tasks/lockfile.mts'
import { generateCodePatch } from './tasks/patch.mts'
import { assessSecurityFix, decideSecurityFix } from './tasks/security-fix.mts'
import { summarizeText } from './tasks/summarize.mts'
import { triageAlerts } from './tasks/triage.mts'
import { decideWeeklyUpdate, planWeeklyUpdate } from './tasks/weekly-update.mts'
export { createMockModel, createMockSession } from './mock.mts'
export type { MockSessionOptions } from './mock.mts'

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
  DEFAULT_PROMPT_TIMEOUT_MS,
  defaultProbeOrder,
  EXIT_NO_BACKEND,
  EXIT_OK,
  EXIT_TASK_FAILURE,
  EXIT_USAGE,
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
  ODAI_TIMEOUT_ENV_VAR,
  parseBatchManifest,
  planWeeklyUpdate,
  reasonAboutLockfile,
  runBatchEntries,
  runCli,
  selectBackend,
  suggestCommitMessage,
  summarizeText,
  triageAlerts,
}

export type { AppleFmBackendOptions } from './backends/apple-fm.mts'
export type { CliArgs, CliCommand } from './cli/args.mts'
export type {
  BatchEntry,
  BatchResultLine,
  BatchTaskCommand,
} from './cli/batch.mts'
export type { LineWriter, RunCliOptions } from './cli/run.mts'
export type { LlamaServerBackendOptions } from './backends/llama-server.mts'
export type { SelectBackendOptions } from './backends/registry.mts'
export type {
  LanguageModelAvailability,
  LanguageModelFactory,
} from './provider.mts'
export type { WindowsPhiSilicaBackendOptions } from './backends/windows-phi-silica.mts'
export type {
  BackendAvailability,
  BackendName,
  OdaiBackend,
} from './backends/types.mts'
export type { CreateOdaiModelOptions, OdaiModel } from './model.mts'
export type { ModelIdentity } from './model-identity.mts'
export type { HoistAssessOptions } from './tasks/hoist.mts'
export type { SecurityFixAssessOptions } from './tasks/security-fix.mts'
export type { WeeklyUpdatePlanOptions } from './tasks/weekly-update.mts'
export type { Message, SchemaLike, SessionLike, TaskResult } from './types.mts'
export type { StreamOptions, StreamResult } from './stream.mts'
export type { DepClassification } from './prompts/classify-deps.mts'
export type { CommitMessage } from './prompts/commit.mts'
export type {
  HoistAssessment,
  HoistBreakingChange,
  HoistExtraction,
  HoistInput,
} from './prompts/hoist.mts'
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

export { analyzeLockstep } from './tasks/lockstep.mts'
export {
  parseLockstepInput,
  validateLockstepAnalysis,
} from './lockstep/validate.mts'
export {
  LockstepInputSchema,
  LockstepAnalysisSchema,
} from './lockstep/schema.mts'
export type { LockstepInput, LockstepAnalysis } from './lockstep/schema.mts'

export { fetchChangelog } from './changelog.mts'

export { classifyIntent } from './tasks/classify-intent.mts'
export type { ClassifyIntentOptions } from './tasks/classify-intent.mts'
export type {
  IntentCandidate,
  IntentInput,
  IntentResult,
} from './prompts/classify-intent.mts'

export { createConversation } from './conversation/create.mts'
export { createBuiltinConversation } from './conversation/builtin.mts'
export { createOdaiConversation } from './conversation/odai.mts'
export { ConversationError } from './conversation/transcript.mts'
export type {
  Conversation,
  ConversationChunk,
  ConversationOptions,
  ConversationPromptOptions,
  ConversationStatus,
  ConversationStreamOptions,
  ConversationStructuredOptions,
  OdaiConversationOptions,
} from './conversation/types.mts'
export type { LanguageModelLike, SessionContextStatus } from './types.mts'
export type { LockstepOptions } from './tasks/lockstep.mts'

export { withOdaiModel } from './lifecycle.mts'
export type {
  OdaiOperationContext,
  OdaiOperationOptions,
} from './lifecycle.mts'
export { probeBackendAvailability } from './availability.mts'
export type {
  BackendProbeOptions,
  BackendProbeResult,
} from './availability.mts'
