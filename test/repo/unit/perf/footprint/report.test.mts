import { expect, test } from 'vitest'

import {
  createFootprintReport,
  emittedPath,
  sanitizeModuleId,
} from '../../../../../scripts/repo/perf/footprint/report.mts'
import type { GeneratedChunk } from '../../../../../scripts/repo/perf/footprint/report.mts'

const ROOT = '/path/to/example'

function chunk(
  file: string,
  options: Partial<GeneratedChunk> = {},
): GeneratedChunk {
  return {
    file: 'dist/' + file,
    directory: 'dist',
    code: 'export const name = ' + JSON.stringify(file),
    entry: false,
    imports: [],
    dynamicImports: [],
    modules: [{ id: ROOT + '/src/' + file, renderedBytes: 20 }],
    ...options,
  }
}

test('counts a CLI static closure, cycles, and incremental dynamic dependencies', () => {
  const shared = chunk('chunk/shared.js', {
    imports: ['./cycle.js', '@example/schema'],
  })
  const chunks = [
    chunk('cli.js', {
      entry: true,
      imports: ['./chunk/shared.js'],
      dynamicImports: ['chunk/lazy.js', '@example/optional'],
    }),
    shared,
    chunk('chunk/cycle.js', { imports: ['chunk/shared.js'] }),
    chunk('chunk/lazy.js', {
      imports: ['./shared.js', './support.js'],
      dynamicImports: ['./nested.js'],
    }),
    chunk('chunk/support.js', { imports: ['node:fs'] }),
    chunk('chunk/nested.js', { imports: ['@example/schema'] }),
    chunk('unused.js'),
    { ...shared },
  ]
  const report = createFootprintReport(chunks, [], ROOT)
  const entry = report.entries[0]!
  expect(entry.static.files).toEqual([
    'dist/chunk/cycle.js',
    'dist/chunk/shared.js',
    'dist/cli.js',
  ])
  expect(entry.dynamic.files).toEqual([
    'dist/chunk/lazy.js',
    'dist/chunk/nested.js',
    'dist/chunk/support.js',
  ])
  expect(entry.reachable.files).toHaveLength(6)
  expect(entry.runtimeExternals).toEqual({
    static: ['@example/schema'],
    dynamic: ['@example/optional', 'node:fs'],
  })
  expect(report.files).toHaveLength(7)
  expect(report.package.files).toContain('dist/unused.js')
  for (const metric of ['raw', 'gzip', 'brotli'] as const) {
    expect(entry.reachable.bytes[metric]).toBe(
      entry.static.bytes[metric] + entry.dynamic.bytes[metric],
    )
    expect(report.package.bytes[metric]).toBe(
      report.files.reduce((total, file) => total + file.bytes[metric], 0),
    )
  }
})

test('counts shared output once for the package and once in each entry closure', () => {
  const shared = chunk('chunk/shared.js')
  const report = createFootprintReport(
    [
      chunk('node.js', { entry: true, imports: ['chunk/shared.js'] }),
      chunk('cli.js', { entry: true, imports: ['./chunk/shared.js'] }),
      shared,
      { ...shared },
    ],
    [],
    ROOT,
  )
  expect(report.package.files).toHaveLength(3)
  expect(report.entries).toHaveLength(2)
  for (const entry of report.entries) {
    expect(entry.static.files).toContain(shared.file)
    expect(entry.dynamic.bytes.raw).toBe(0)
  }
  expect(
    report.entries.reduce((total, entry) => total + entry.static.bytes.raw, 0),
  ).toBeGreaterThan(report.package.bytes.raw)
  expect(
    report.package.topModules.find(
      module => module.id === 'src/chunk/shared.js',
    ),
  ).toEqual({ id: 'src/chunk/shared.js', renderedBytes: 20 })
})

test('rejects colliding emitted JavaScript instead of hiding overwritten bytes', () => {
  expect(() =>
    createFootprintReport(
      [chunk('shared.js'), chunk('shared.js', { code: 'different bytes' })],
      [],
      ROOT,
    ),
  ).toThrow()
})

test('keeps deterministic module attribution without absolute cache paths', () => {
  const chunks = [
    chunk('browser.js', {
      entry: true,
      modules: [
        {
          id: '/cache/store/node_modules/@example/schema/index.js',
          renderedBytes: 30,
        },
        { id: ROOT + '/src/browser.mts', renderedBytes: 10 },
        {
          id: '/cache/other/node_modules/@example/schema/index.js',
          renderedBytes: 20,
        },
      ],
    }),
    chunk('node.js'),
  ]
  const report = createFootprintReport(chunks, [], ROOT)
  expect(report.package.topModules[0]).toEqual({
    id: '@example/schema/index.js',
    renderedBytes: 50,
  })
  expect(createFootprintReport([...chunks].reverse(), [], ROOT)).toEqual(report)
  expect(
    sanitizeModuleId(
      'C:\\cache\\node_modules\\@example\\schema\\index.js',
      ROOT,
    ),
  ).toBe('@example/schema/index.js')
  expect(sanitizeModuleId('\0virtual:runtime', ROOT)).toBe('virtual:runtime')
  expect(sanitizeModuleId('file://' + ROOT + '/src/browser.mts', ROOT)).toBe(
    'src/browser.mts',
  )
  expect(sanitizeModuleId('virtual:/outside/workspace/helper.mts', ROOT)).toBe(
    'outside-root/helper.mts',
  )
  expect(sanitizeModuleId('/outside/workspace/helper.mts', ROOT)).toBe(
    'outside-root/helper.mts',
  )
})

test('reports assets separately and keeps empty JavaScript totals valid', () => {
  const asset = {
    file: 'dist/model.wasm',
    source: Uint8Array.from([0, 97, 115, 109]),
  }
  const report = createFootprintReport([], [asset, asset], ROOT)
  expect(report.package.bytes).toEqual({ raw: 0, gzip: 0, brotli: 0 })
  expect(report.entries).toEqual([])
  expect(report.assets).toHaveLength(1)
  expect(report.assets[0]!.bytes.raw).toBe(4)
  expect(emittedPath('dist', 'chunk/shared.js')).toBe('dist/chunk/shared.js')
  expect(() => emittedPath('dist', '../../outside.js')).toThrow()
})
