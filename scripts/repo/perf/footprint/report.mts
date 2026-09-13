import path from 'node:path'

import { compareStr } from '@socketsecurity/lib-stable/sorts/strings'

import { measureBytes } from './bytes.mts'
import type { ByteLengths } from './bytes.mts'

export interface ModuleContribution {
  id: string
  renderedBytes: number
}

export interface GeneratedChunk {
  file: string
  directory: string
  code: string
  entry: boolean
  imports: readonly string[]
  dynamicImports: readonly string[]
  modules: readonly ModuleContribution[]
}

export interface GeneratedAsset {
  file: string
  source: string | Uint8Array
}

export interface MeasuredChunk {
  file: string
  entry: boolean
  bytes: ByteLengths
  imports: string[]
  dynamicImports: string[]
  externalImports: string[]
  externalDynamicImports: string[]
  modules: readonly ModuleContribution[]
}

export interface FootprintSummary {
  files: string[]
  bytes: ByteLengths
  topModules: ModuleContribution[]
}

export interface FootprintTraversalOptions {
  includeDynamic?: boolean | undefined
}

const TOP_MODULES = 20

export function sortedFootprintNames(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted(compareStr)
}

export function sanitizeModuleId(id: string, root: string): string {
  const normalized = id
    .replaceAll('\\', '/')
    .replaceAll('\0', '')
    .replace(/^file:\/\//u, '')
  const modules = normalized.lastIndexOf('/node_modules/')
  if (modules !== -1) {
    return normalized.slice(modules + '/node_modules/'.length)
  }
  const prefix = root.replaceAll('\\', '/').replace(/\/$/, '') + '/'
  const relative = normalized.replaceAll(prefix, '')
  if (path.posix.isAbsolute(relative) || relative.includes(':/')) {
    return 'outside-root/' + path.posix.basename(relative)
  }
  return relative
}

export function emittedPath(directory: string, name: string): string {
  const file = path.posix.normalize(
    path.posix.join(
      directory.replaceAll('\\', '/'),
      name.replaceAll('\\', '/'),
    ),
  )
  if (path.posix.isAbsolute(file) || file === '..' || file.startsWith('../')) {
    throw new Error('Bundle output must stay inside the repository: ' + name)
  }
  return file
}

export function resolveFootprintReference(
  chunk: GeneratedChunk,
  reference: string,
  files: ReadonlyMap<string, GeneratedChunk>,
): string | undefined {
  const base = reference.startsWith('.')
    ? path.posix.dirname(chunk.file)
    : chunk.directory
  const candidate = path.posix.normalize(path.posix.join(base, reference))
  if (files.has(candidate)) {
    return candidate
  }
  const direct = path.posix.normalize(reference)
  return files.has(direct) ? direct : undefined
}

export function partitionFootprintReferences(
  chunk: GeneratedChunk,
  values: readonly string[],
  files: ReadonlyMap<string, GeneratedChunk>,
  root: string,
) {
  const internal: string[] = []
  const external: string[] = []
  for (let index = 0, { length } = values; index < length; index += 1) {
    const reference = values[index]!
    const resolved = resolveFootprintReference(chunk, reference, files)
    if (resolved === undefined) {
      external.push(sanitizeModuleId(reference, root))
    } else {
      internal.push(resolved)
    }
  }
  return {
    __proto__: null,
    internal: sortedFootprintNames(internal),
    external: sortedFootprintNames(external),
  }
}

export function collectFootprintChunks(chunks: readonly GeneratedChunk[]) {
  const unique = new Map<string, GeneratedChunk>()
  for (let index = 0, { length } = chunks; index < length; index += 1) {
    const chunk = chunks[index]!
    const previous = unique.get(chunk.file)
    if (previous !== undefined && previous.code !== chunk.code) {
      throw new Error(
        'Different generated chunks overwrite the same path: ' + chunk.file,
      )
    }
    if (previous === undefined || chunk.entry) {
      unique.set(chunk.file, chunk)
    }
  }
  return unique
}

export function measureFootprintChunks(
  chunks: readonly GeneratedChunk[],
  root: string,
) {
  const unique = collectFootprintChunks(chunks)
  const measured = new Map<string, MeasuredChunk>()
  for (const file of sortedFootprintNames(unique.keys())) {
    const chunk = unique.get(file)!
    const eager = partitionFootprintReferences(
      chunk,
      chunk.imports,
      unique,
      root,
    )
    const dynamic = partitionFootprintReferences(
      chunk,
      chunk.dynamicImports,
      unique,
      root,
    )
    measured.set(file, {
      __proto__: null,
      file,
      entry: chunk.entry,
      bytes: measureBytes(chunk.code),
      imports: eager.internal,
      dynamicImports: dynamic.internal,
      externalImports: eager.external,
      externalDynamicImports: dynamic.external,
      modules: chunk.modules.map(module => ({
        __proto__: null,
        id: sanitizeModuleId(module.id, root),
        renderedBytes: module.renderedBytes,
      })),
    } as MeasuredChunk)
  }
  return measured
}

export function collectFootprintClosure(
  entry: string,
  files: ReadonlyMap<string, MeasuredChunk>,
  options?: FootprintTraversalOptions | undefined,
) {
  const opts = { __proto__: null, ...options }
  const visited = new Set<string>()
  const pending = [entry]
  while (pending.length !== 0) {
    const file = pending.pop()!
    if (visited.has(file)) {
      continue
    }
    visited.add(file)
    const chunk = files.get(file)!
    pending.push(...chunk.imports)
    if (opts.includeDynamic) {
      pending.push(...chunk.dynamicImports)
    }
  }
  return visited
}

export function topFootprintModules(
  contributions: readonly ModuleContribution[],
) {
  const totals = new Map<string, number>()
  for (let index = 0, { length } = contributions; index < length; index += 1) {
    const module = contributions[index]!
    totals.set(module.id, (totals.get(module.id) ?? 0) + module.renderedBytes)
  }
  return [...totals]
    .map(([id, renderedBytes]) => ({
      __proto__: null,
      id,
      renderedBytes,
    }))
    .toSorted(
      (left, right) =>
        right.renderedBytes - left.renderedBytes ||
        compareStr(left.id, right.id),
    )
    .slice(0, TOP_MODULES)
}

export function summarizeFootprintFiles(
  names: Iterable<string>,
  files: ReadonlyMap<string, MeasuredChunk>,
): FootprintSummary {
  const selected = sortedFootprintNames(names)
  const bytes = { __proto__: null, raw: 0, gzip: 0, brotli: 0 } as ByteLengths
  const modules: ModuleContribution[] = []
  for (let index = 0, { length } = selected; index < length; index += 1) {
    const chunk = files.get(selected[index]!)!
    bytes.raw += chunk.bytes.raw
    bytes.gzip += chunk.bytes.gzip
    bytes.brotli += chunk.bytes.brotli
    modules.push(...chunk.modules)
  }
  return {
    __proto__: null,
    files: selected,
    bytes,
    topModules: topFootprintModules(modules),
  } as FootprintSummary
}

export function collectFootprintExternals(
  names: Iterable<string>,
  files: ReadonlyMap<string, MeasuredChunk>,
  options?: FootprintTraversalOptions | undefined,
) {
  const opts = { __proto__: null, ...options }
  const result = new Set<string>()
  for (const name of names) {
    const chunk = files.get(name)!
    for (const reference of chunk.externalImports) {
      result.add(reference)
    }
    if (opts.includeDynamic) {
      for (const reference of chunk.externalDynamicImports) {
        result.add(reference)
      }
    }
  }
  return sortedFootprintNames(result)
}

export function createEntryFootprint(
  file: string,
  files: ReadonlyMap<string, MeasuredChunk>,
) {
  const eager = collectFootprintClosure(file, files, { includeDynamic: false })
  const reachable = collectFootprintClosure(file, files, {
    includeDynamic: true,
  })
  const dynamic = [...reachable].filter(name => !eager.has(name))
  const staticExternals = collectFootprintExternals(eager, files, {
    includeDynamic: false,
  })
  const eagerExternals = new Set(staticExternals)
  return {
    __proto__: null,
    file,
    static: summarizeFootprintFiles(eager, files),
    dynamic: summarizeFootprintFiles(dynamic, files),
    reachable: summarizeFootprintFiles(reachable, files),
    runtimeExternals: {
      __proto__: null,
      static: staticExternals,
      dynamic: collectFootprintExternals(reachable, files, {
        includeDynamic: true,
      }).filter(name => !eagerExternals.has(name)),
    },
  }
}

export function createFootprintReport(
  chunks: readonly GeneratedChunk[],
  assets: readonly GeneratedAsset[],
  root: string,
) {
  const files = measureFootprintChunks(chunks, root)
  const entries = [...files.values()].filter(file => file.entry)
  const uniqueAssets = new Map(assets.map(asset => [asset.file, asset]))
  return {
    __proto__: null,
    schemaVersion: 1,
    units: 'bytes',
    measurement: {
      __proto__: null,
      gzipLevel: 9,
      brotliQuality: 11,
      compressedTotals: 'Sum of individually compressed emitted files.',
      dynamicClosure:
        'Additional emitted files reachable through dynamic imports, excluding the static closure.',
      packageScope:
        'All generated JavaScript chunks, deduplicated by emitted path. Assets are separate.',
      runtimeExternals:
        'Import specifiers only. Installed dependency bytes are excluded.',
      moduleContributors:
        'Rolldown renderedLength, summed across distinct emitted chunks. Wrapper and compression overhead are not attributed.',
      topModuleLimit: TOP_MODULES,
    },
    package: {
      __proto__: null,
      ...summarizeFootprintFiles(files.keys(), files),
      runtimeExternals: collectFootprintExternals(files.keys(), files, {
        includeDynamic: true,
      }),
    },
    entries: entries.map(entry => createEntryFootprint(entry.file, files)),
    files: [...files.values()].map(({ modules, ...file }) => ({
      __proto__: null,
      ...file,
      topModules: topFootprintModules(modules),
    })),
    assets: sortedFootprintNames(uniqueAssets.keys()).map(file => ({
      __proto__: null,
      file,
      bytes: measureBytes(uniqueAssets.get(file)!.source),
    })),
  }
}
