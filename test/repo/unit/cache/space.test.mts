import { expect, test, vi } from 'vitest'

import {
  ensureGemmaProvisionSpace,
  GEMMA_REQUIRED_FREE_BYTES,
} from '../../../../scripts/repo/cache/space.mts'

test('keeps Rust caches when the Gemma free-space floor is already met', async () => {
  const runRustSweep = vi.fn()
  await expect(
    ensureGemmaProvisionSpace('/example/profile', {
      readAvailableBytes: async () => GEMMA_REQUIRED_FREE_BYTES,
      runRustSweep,
    }),
  ).resolves.toEqual({
    availableAfterBytes: GEMMA_REQUIRED_FREE_BYTES,
    availableBeforeBytes: GEMMA_REQUIRED_FREE_BYTES,
    swept: false,
  })
  expect(runRustSweep).not.toHaveBeenCalled()
})

test('runs the Rust sweep below the floor and accepts measured recovery', async () => {
  const readAvailableBytes = vi
    .fn()
    .mockResolvedValueOnce(9 * 1024 ** 3)
    .mockResolvedValueOnce(42 * 1024 ** 3)
  const runRustSweep = vi.fn().mockResolvedValue(0)
  await expect(
    ensureGemmaProvisionSpace('/example/profile', {
      readAvailableBytes,
      runRustSweep,
    }),
  ).resolves.toEqual({
    availableAfterBytes: 42 * 1024 ** 3,
    availableBeforeBytes: 9 * 1024 ** 3,
    swept: true,
  })
  expect(runRustSweep).toHaveBeenCalledOnce()
  expect(readAvailableBytes).toHaveBeenCalledTimes(2)
})

test('fails when the sweep cannot run or cannot reach the floor', async () => {
  await expect(
    ensureGemmaProvisionSpace('/example/profile', {
      readAvailableBytes: async () => 9 * 1024 ** 3,
      runRustSweep: async () => 1,
    }),
  ).rejects.toThrow(/failed sweep/u)
  await expect(
    ensureGemmaProvisionSpace('/example/profile', {
      readAvailableBytes: vi
        .fn()
        .mockResolvedValueOnce(9 * 1024 ** 3)
        .mockResolvedValueOnce(18 * 1024 ** 3),
      runRustSweep: async () => 0,
    }),
  ).rejects.toThrow(/18GiB free after/u)
})
