import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

import { REPO_ROOT } from '../../fleet/paths.mts'

export const GEMMA_REQUIRED_FREE_BYTES = 22 * 1024 ** 3

export interface GemmaSpaceResult {
  availableAfterBytes: number
  availableBeforeBytes: number
  swept: boolean
}

interface GemmaSpaceDependencies {
  readAvailableBytes(directory: string): Promise<number>
  runRustSweep(): Promise<number>
}

async function readAvailableBytes(directory: string): Promise<number> {
  const disk = await fs.statfs(directory)
  return disk.bavail * disk.bsize
}

async function runRustSweep(): Promise<number> {
  const result = await spawn(
    process.execPath,
    [
      path.join(REPO_ROOT, 'scripts/fleet/rust-target-sweep.mts'),
      '--projects',
      '--fix',
    ],
    { cwd: REPO_ROOT, stdio: 'inherit', throws: false },
  )
  return result.code ?? 1
}

export async function ensureGemmaProvisionSpace(
  profile: string,
  dependencies?: Partial<GemmaSpaceDependencies> | undefined,
): Promise<GemmaSpaceResult> {
  const deps: GemmaSpaceDependencies = {
    readAvailableBytes,
    runRustSweep,
    ...dependencies,
  }
  const availableBeforeBytes = await deps.readAvailableBytes(profile)
  if (availableBeforeBytes >= GEMMA_REQUIRED_FREE_BYTES) {
    return {
      availableAfterBytes: availableBeforeBytes,
      availableBeforeBytes,
      swept: false,
    }
  }
  const exitCode = await deps.runRustSweep()
  if (exitCode !== 0) {
    throw new Error(
      'Gemma provisioning could not reclaim disk space. Where: Rust target sweep. Saw a failed sweep; wanted at least 22GiB free. Fix: finish active Rust builds, inspect the sweep output, and retry provisioning.',
    )
  }
  const availableAfterBytes = await deps.readAvailableBytes(profile)
  if (availableAfterBytes < GEMMA_REQUIRED_FREE_BYTES) {
    throw new Error(
      `Gemma provisioning still has insufficient disk space at ${profile}. Saw ${Math.floor(availableAfterBytes / 1024 ** 3)}GiB free after the Rust target sweep; wanted at least 22GiB. Fix: reclaim another cache and retry provisioning.`,
    )
  }
  return {
    availableAfterBytes,
    availableBeforeBytes,
    swept: true,
  }
}
