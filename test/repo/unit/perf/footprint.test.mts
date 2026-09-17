import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { REPO_ROOT } from '../../../../scripts/fleet/paths.mts'
import {
  footprintOutputDirectory,
  generateFootprint,
} from '../../../../scripts/repo/perf/footprint.mts'

const mocks = vi.hoisted(() => ({ rolldown: vi.fn() }))

vi.mock(import('rolldown'), () => ({ rolldown: mocks.rolldown }))
vi.mock(import('../../../../.config/repo/rolldown.config.mts'), () => ({
  default: [{ input: 'src/index.mts', output: { dir: 'dist' } }],
}))

beforeEach(() => {
  mocks.rolldown.mockReset()
})

describe('footprint entrypoint', () => {
  it('resolves output directories consistently for directory, file, and default builds', () => {
    expect(footprintOutputDirectory({ dir: 'dist/bench' })).toBe('dist/bench')
    expect(footprintOutputDirectory({ file: 'dist/node.js' })).toBe('dist')
    expect(footprintOutputDirectory({})).toBe('dist')
    expect(
      footprintOutputDirectory({ dir: path.join(REPO_ROOT, 'dist') }),
    ).toBe('dist')
  })

  it('measures generated chunks and assets without writing a bundle', async () => {
    const code = 'export const value = 1;'
    const asset = new Uint8Array([1, 2, 3])
    const close = vi.fn().mockResolvedValue(undefined)
    const generate = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'chunk',
          fileName: 'index.js',
          code,
          isEntry: true,
          imports: [],
          dynamicImports: [],
          modules: { 'src/index.mts': { renderedLength: code.length } },
        },
        { type: 'asset', fileName: 'model.wasm', source: asset },
      ],
    })
    mocks.rolldown.mockResolvedValue({ generate, close })
    const report = await generateFootprint()
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]).toMatchObject({
      file: 'dist/index.js',
      static: { files: ['dist/index.js'], bytes: { raw: code.length } },
    })
    expect(report.assets).toEqual([
      expect.objectContaining({
        file: 'dist/model.wasm',
        bytes: expect.objectContaining({ raw: asset.length }),
      }),
    ])
    expect(generate).toHaveBeenCalledExactlyOnceWith({ dir: 'dist' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the bundler when output generation fails', async () => {
    const error = new Error('generation failed')
    const close = vi.fn().mockResolvedValue(undefined)
    mocks.rolldown.mockResolvedValue({
      generate: vi.fn().mockRejectedValue(error),
      close,
    })
    await expect(generateFootprint()).rejects.toBe(error)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
