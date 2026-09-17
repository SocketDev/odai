import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { stringify, writeJson } from '@socketsecurity/lib-stable/fs/write-json'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { rolldown } from 'rolldown'
import type { OutputOptions } from 'rolldown'

import configs from '../../../.config/repo/rolldown.config.mts'
import { REPO_ROOT } from '../../fleet/paths.mts'
import { sharedScriptsFleetFormatMtsPath } from '../../fleet/paths/util.mts'
import { isMainModule } from '../../fleet/process/is-main-module.mts'
import { runMain } from '../../fleet/process/run-main.mts'
import { createFootprintReport, emittedPath } from './footprint/report.mts'
import type { GeneratedAsset, GeneratedChunk } from './footprint/report.mts'

export function footprintOutputDirectory(options: OutputOptions): string {
  const opts = { __proto__: null, ...options } as OutputOptions
  const directory = opts.dir ?? path.dirname(opts.file ?? 'dist/index.js')
  return path.relative(REPO_ROOT, path.resolve(REPO_ROOT, directory))
}

export async function generateFootprint() {
  const chunks: GeneratedChunk[] = []
  const assets: GeneratedAsset[] = []
  for (
    let index = 0, { length: configLength } = configs;
    index < configLength;
    index += 1
  ) {
    const config = configs[index]!
    const bundle = await rolldown(config)
    try {
      const outputs = Array.isArray(config.output)
        ? config.output
        : [config.output ?? {}]
      for (
        let outputIndex = 0, { length: outputLength } = outputs;
        outputIndex < outputLength;
        outputIndex += 1
      ) {
        const options = outputs[outputIndex]!
        const directory = footprintOutputDirectory(options)
        const { output } = await bundle.generate(options)
        for (
          let fileIndex = 0, { length: fileLength } = output;
          fileIndex < fileLength;
          fileIndex += 1
        ) {
          const item = output[fileIndex]!
          const file = emittedPath(directory, item.fileName)
          if (item.type === 'asset') {
            assets.push({
              __proto__: null,
              file,
              source: item.source,
            } as GeneratedAsset)
            continue
          }
          chunks.push({
            __proto__: null,
            file,
            directory,
            code: item.code,
            entry: item.isEntry,
            imports: [...item.imports],
            dynamicImports: [...item.dynamicImports],
            modules: Object.entries(item.modules).map(([id, module]) => ({
              __proto__: null,
              id,
              renderedBytes: module.renderedLength,
            })),
          } as GeneratedChunk)
        }
      }
    } finally {
      await bundle.close()
    }
  }
  return createFootprintReport(chunks, assets, REPO_ROOT)
}

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { output: { type: 'string' }, json: { type: 'boolean' } },
    strict: true,
    allowPositionals: false,
  })
  const report = await generateFootprint()
  if (values.output === undefined) {
    process.stdout.write(stringify(report))
    return
  }
  const destination = path.resolve(REPO_ROOT, values.output)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await writeJson(destination, report)
  await spawn(
    process.execPath,
    [sharedScriptsFleetFormatMtsPath(REPO_ROOT), destination],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  )
}

const SCRIPT_META = {
  describe:
    'Measure generated JavaScript bytes and complete entry import closures without writing dist.',
  help: 'Usage: pnpm run perf:footprint [--output <path>]\nWithout --output, prints the JSON report to stdout.',
  json: 'native',
} as const

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
