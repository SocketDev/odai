import { selectBackend } from './backends/registry.mts'
import type { BackendName } from './backends/types.mts'

export interface BackendProbeOptions {
  abortSignal?: AbortSignal | undefined
  backend?: BackendName | undefined
}

export interface BackendProbeResult {
  available: boolean
  backend?: BackendName | undefined
}

export async function probeBackendAvailability(
  options: BackendProbeOptions = {},
): Promise<BackendProbeResult> {
  try {
    const backend = await selectBackend({ ...options, interactive: true })
    return { available: true, backend: backend.name }
  } catch (error) {
    options.abortSignal?.throwIfAborted()
    return { available: false }
  }
}
