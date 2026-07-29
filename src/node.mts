/**
 * @file Node entry point. Exports the backend registry, a deterministic mock
 *   session, and all task helpers. Tests and CLI tools run without Chrome:
 *   the simulator backend closes the probe order, so `createOdaiModel()`
 *   always yields a working model here.
 */

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
import { promptStructured } from './json.mts'
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
import { reasonAboutLockfile } from './tasks/lockfile.mts'
import { generateCodePatch } from './tasks/patch.mts'
import { summarizeText } from './tasks/summarize.mts'
import { triageAlerts } from './tasks/triage.mts'
import type { OdaiModel } from './model.mts'
import type {
  Message,
  SessionLike,
  StructuredPromptOptions,
  TaskResult,
} from './types.mts'
import type { StreamOptions } from './stream.mts'

export function createMockModel(response: string): OdaiModel {
  const session = createMockSession({ response })
  return {
    async promptStructured<T>(
      userContent: string,
      options: StructuredPromptOptions<T>,
    ): Promise<TaskResult<T>> {
      return promptStructured(session, userContent, options)
    },
    async promptStreaming(
      userContent: string,
      options?: StreamOptions | undefined,
    ): Promise<{ raw: string }> {
      void userContent
      void options
      return { raw: response }
    },
    rawSession(): SessionLike {
      return session
    },
  }
}

// socket-lint: allow no-required-in-options-bag — published API shape; renaming
// the exported interface or reshaping the bag is a breaking change.
export interface MockSessionOptions {
  response: string
}

export function createMockSession(options: MockSessionOptions): SessionLike {
  const opts = { __proto__: null, ...options } as typeof options
  return {
    async prompt(messages: Message[]): Promise<string> {
      void messages
      return opts.response
    },
    promptStreaming(): AsyncIterable<string> {
      return (async function* generate(): AsyncGenerator<string> {
        yield opts.response
      })()
    },
  }
}

export {
  backendNames,
  CONTROL_TOKENS,
  detectModelName,
  formatControlTokens,
  matchModelName,
  parseControlTokens,
  classifyDependencyChange,
  createAppleFmBackend,
  createBackend,
  createChromeBuiltinBackend,
  createLlamaServerBackend,
  createLocalLanguageModelFactory,
  createOdaiModel,
  createSimulatorBackend,
  createWindowsPhiSilicaBackend,
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
  ODAI_APPLE_FM_SHIM_ENV_VAR,
  ODAI_BACKEND_ENV_VAR,
  ODAI_LLAMA_MODEL_ENV_VAR,
  ODAI_LLAMA_URL_ENV_VAR,
  ODAI_TIMEOUT_ENV_VAR,
  reasonAboutLockfile,
  runCli,
  selectBackend,
  suggestCommitMessage,
  summarizeText,
  triageAlerts,
}

export type { AppleFmBackendOptions } from './backends/apple-fm.mts'
export type { CliArgs, CliCommand } from './cli/args.mts'
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
export type { Message } from './types.mts'
export type { DepClassification } from './prompts/classify-deps.mts'
export type { CommitMessage } from './prompts/commit.mts'
export type { TextSummary } from './prompts/summarize.mts'
export type { AlertTriage } from './prompts/triage.mts'
