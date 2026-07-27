/**
 * @file Rolldown configuration for the Gemini Nano library. Bundles the browser
 *   entry to a CJS artifact at `dist/index.js`.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RolldownOptions } from 'rolldown'

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
}

const nodeConfig: RolldownOptions = {
  ...baseConfig,
  input: path.join(srcPath, 'node.mts'),
  output: {
    ...baseConfig.output,
    entryFileNames: 'node.js',
  },
  platform: 'node',
}

const cliConfig: RolldownOptions = {
  ...baseConfig,
  input: path.join(srcPath, 'cli.mts'),
  output: {
    ...baseConfig.output,
    banner: '#!/usr/bin/env node',
    entryFileNames: 'cli.js',
  },
  platform: 'node',
}

const benchConfig: RolldownOptions = {
  ...baseConfig,
  external: ['playwright-core'],
  input: path.join(srcPath, 'bench/index.mts'),
  output: {
    ...baseConfig.output,
    entryFileNames: 'bench/index.js',
    format: 'esm',
  },
  platform: 'browser',
}

const browserEsmConfig: RolldownOptions = {
  ...baseConfig,
  external: ['playwright-core'],
  input: path.join(srcPath, 'index.mts'),
  output: {
    ...baseConfig.output,
    entryFileNames: 'index.esm.js',
    format: 'esm',
  },
  platform: 'browser',
}

const configs: readonly RolldownOptions[] = [
  browserConfig,
  nodeConfig,
  cliConfig,
  benchConfig,
  browserEsmConfig,
]

export default configs
