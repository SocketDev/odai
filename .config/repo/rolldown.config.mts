/**
 * @file Build the browser, Node, CLI, and benchmark entries as CommonJS.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RolldownOptions } from 'rolldown'
import { acornWasmPlugin } from './rolldown-plugin/acorn.mts'

const rootPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)
const srcPath = path.join(rootPath, 'src')
const distPath = path.join(rootPath, 'dist')

const baseConfig = {
  // playwright-core is an optional peer dependency loaded lazily by the
  // gemini-nano-headless bridge; bundling it drags in native fsevents.
  external: ['@sinclair/typebox', 'playwright-core'],
  output: {
    chunkFileNames: 'chunk/[name]-[hash].js',
    dir: distPath,
    format: 'cjs' as const,
    minify: false,
    sourcemap: false,
  },
  treeshake: true,
}

const browserConfig: RolldownOptions = {
  ...baseConfig,
  input: path.join(srcPath, 'index.mts'),
  output: {
    ...baseConfig.output,
    entryFileNames: 'index.js',
  },
  platform: 'browser',
  plugins: [
    {
      name: 'browser-backends',
      resolveId(source, importer) {
        if (importer === undefined || !source.startsWith('.')) {
          return undefined
        }
        const resolved = path.resolve(path.dirname(importer), source)
        for (const backend of ['apple-fm', 'chrome-builtin']) {
          if (resolved === path.join(srcPath, 'backends', `${backend}.mts`)) {
            return path.join(srcPath, 'backends', `${backend}.browser.mts`)
          }
        }
        return undefined
      },
    },
  ],
}

const nodeConfig: RolldownOptions = {
  ...baseConfig,
  input: {
    cli: path.join(srcPath, 'cli.mts'),
    node: path.join(srcPath, 'node.mts'),
  },
  output: {
    ...baseConfig.output,
    banner: chunk => (chunk.name === 'cli' ? '#!/usr/bin/env node' : ''),
    entryFileNames: '[name].js',
  },
  platform: 'node',
}

const benchConfig: RolldownOptions = {
  ...baseConfig,
  plugins: [acornWasmPlugin()],
  external: ['playwright-core'],
  input: path.join(srcPath, 'bench/index.mts'),
  output: {
    ...baseConfig.output,
    entryFileNames: 'bench/index.js',
    format: 'cjs',
  },
  platform: 'browser',
}

const configs: readonly RolldownOptions[] = [
  browserConfig,
  nodeConfig,
  benchConfig,
]

export default configs
