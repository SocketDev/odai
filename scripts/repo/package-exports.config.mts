/**
 * @file Exports-config for the public-files-are-exported check. The ignore
 *   globs name rolldown's internal code-split chunks — the lazily imported
 *   apple-fm shim module, the intl helpers it pulls in, and the logger
 *   default module the node and cli bundles share — which are reachable only
 *   through the exported entry bundles and the bin, never as exports entries
 *   of their own.
 */

export const config = {
  ignore: ['dist/apple-fm-shim-*.js', 'dist/default-*.js', 'dist/intl-*.js'],
}
