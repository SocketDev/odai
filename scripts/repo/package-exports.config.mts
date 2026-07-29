/*
 * @file Exports-config for the package-exports generator + the
 *   public-files-are-exported check. Shape follows socket-packageurl-js: the
 *   runtime surface is `.`, `./node`, and `./bench` (dist-based, `outDir`
 *   strips the dist/ prefix from subpaths), single-format CJS with
 *   source/types/default conditions. The ignore globs cover what ships in the
 *   tarball but must NOT become an export entry of its own:
 *
 *   - rolldown's internal code-split chunks (the lazily imported apple-fm shim,
 *     the intl helpers, the shared logger default module) — reachable only
 *     through the exported entry bundles;
 *   - `dist/cli.js`, the `odai` bin — consumers run it, never import it, and as a
 *     bin it ships no declaration twin.
 */

import type { ExportsConfig } from '../fleet/gen/package-exports.mts'
import { REPO_ROOT } from '../fleet/paths.mts'

export const packageDir: string = REPO_ROOT

export const config: ExportsConfig = {
  files: ['dist/**/*.{cjs,js,mjs,d.ts,d.mts,d.cts}', 'package.json'],
  ignore: [
    'dist/apple-fm-shim-*.js',
    'dist/cli.js',
    'dist/default-*.js',
    'dist/intl-*.js',
  ],
  outDir: 'dist',
}
