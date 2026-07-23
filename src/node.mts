/**
 * @file Node entry point. Exports the backend registry, a deterministic mock
 *   session, and all task helpers. Tests and CLI tools run without Chrome:
 *   the simulator backend closes the probe order, so `createLocaiModel()`
 *   always yields a working model here.
 */

import {
  createAppleFmBackend,
  LOCAI_APPLE_FM_SHIM_ENV_VAR,
} from './backends/apple-fm.mts'
import { createGeminiNanoHeadlessBackend } from './backends/gemini-nano-headless.mts'
import {
  createLlamaServerBackend,
  DEFAULT_LLAMA_URL,
  LOCAI_LLAMA_MODEL_ENV_VAR,
  LOCAI_LLAMA_URL_ENV_VAR,
} from './backends/llama-server.mts'
import {
  backendNames,
  createBackend,
  defaultProbeOrder,
  LOCAI_BACKEND_ENV_VAR,
  selectBackend,
} from './backends/registry.mts'
import { createSimulatorBackend } from './backends/simulator.mts'
import { promptStructured } from './json.mts'
import { createLocaiModel } from './model.mts'
import {
  installLanguageModelSimulator,
  LanguageModelSessionSimulator,
  LanguageModelSimulator,
} from './simulator.mts'
import { dedupeDependencies } from './tasks/dedupe.mts'
import { reasonAboutLockfile } from './tasks/lockfile.mts'
import { generateCodePatch } from './tasks/patch.mts'
import type { GeminiNanoModel } from './model.mts'
import type {
  Message,
  SessionLike,
  StructuredPromptOptions,
  TaskResult,
} from './types.mts'
import type { StreamOptions } from './stream.mts'

export function createMockModel(response: string): GeminiNanoModel {
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
  createAppleFmBackend,
  createBackend,
  createGeminiNanoHeadlessBackend,
  createLlamaServerBackend,
  createLocaiModel,
  createSimulatorBackend,
  dedupeDependencies,
  DEFAULT_LLAMA_URL,
  defaultProbeOrder,
  generateCodePatch,
  installLanguageModelSimulator,
  LanguageModelSimulator,
  LanguageModelSessionSimulator,
  LOCAI_APPLE_FM_SHIM_ENV_VAR,
  LOCAI_BACKEND_ENV_VAR,
  LOCAI_LLAMA_MODEL_ENV_VAR,
  LOCAI_LLAMA_URL_ENV_VAR,
  reasonAboutLockfile,
  selectBackend,
}

export type { AppleFmBackendOptions } from './backends/apple-fm.mts'
export type { LlamaServerBackendOptions } from './backends/llama-server.mts'
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
