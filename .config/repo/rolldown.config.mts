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
  external: ['@sinclair/typebox'],
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

const configs: readonly RolldownOptions[] = [browserConfig, nodeConfig]

export default configs
