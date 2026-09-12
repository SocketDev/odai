import { beforeEach, expect, it, vi } from 'vitest'
import { buildShimBinary } from '../../src/backends/apple-fm-shim.mts'

const fixtures = vi.hoisted(() => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
  exec: vi.fn(),
}))
vi.mock(import('node:fs/promises'), async importOriginal => ({
  ...(await importOriginal()),
  access: fixtures.access,
  mkdir: fixtures.mkdir,
  rename: fixtures.rename,
  writeFile: fixtures.writeFile,
}))
vi.mock(import('node:child_process'), async importOriginal => {
  const original = await importOriginal()
  const { promisify } = await import('node:util')
  const holder = { execFile: original.execFile }
  vi.spyOn(holder, 'execFile').mockImplementation(() => {
    throw new Error('Fixture requires the promisified compiler interface')
  })
  Object.defineProperty(holder.execFile, promisify.custom, {
    value: fixtures.exec,
  })
  return { ...original, execFile: holder.execFile }
})

beforeEach(() => {
  vi.clearAllMocks()
  fixtures.access.mockRejectedValue(
    Object.assign(new Error('Missing executable'), { code: 'ENOENT' }),
  )
  fixtures.exec.mockResolvedValue({ stdout: '', stderr: '' })
})

it('compiles into a staging file before publishing the executable', async () => {
  expect(await buildShimBinary('/fixture/cache', '/fixture/cache/shim')).toBe(
    '/fixture/cache/shim',
  )
  expect(fixtures.exec.mock.calls[0]).toEqual(['xcrun', ['--find', 'swiftc']])
  expect(fixtures.writeFile).toHaveBeenCalledWith(
    '/fixture/cache/shim.swift',
    expect.stringContaining('import FoundationModels'),
  )
  expect(fixtures.exec.mock.calls[1]).toEqual([
    'xcrun',
    [
      'swiftc',
      '-O',
      '/fixture/cache/shim.swift',
      '-o',
      `/fixture/cache/shim.${process.pid}.tmp`,
    ],
    { timeout: 300_000 },
  ])
  expect(fixtures.rename).toHaveBeenCalledWith(
    `/fixture/cache/shim.${process.pid}.tmp`,
    '/fixture/cache/shim',
  )
})

it('does not publish a failed compilation', async () => {
  fixtures.exec
    .mockResolvedValueOnce({ stdout: '', stderr: '' })
    .mockRejectedValueOnce(new Error('compiler failed'))
  await expect(
    buildShimBinary('/fixture/cache', '/fixture/cache/shim'),
  ).rejects.toThrow()
  expect(fixtures.rename).not.toHaveBeenCalled()
})

it('reports missing compiler without creating source files', async () => {
  fixtures.exec.mockRejectedValueOnce(
    Object.assign(new Error('missing tool'), { code: 'ENOENT' }),
  )
  await expect(
    buildShimBinary('/fixture/cache', '/fixture/cache/shim'),
  ).rejects.toThrow()
  expect(fixtures.writeFile).not.toHaveBeenCalled()
  expect(fixtures.rename).not.toHaveBeenCalled()
})
