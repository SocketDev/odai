/**
 * @file Exports-config for the public-files-are-exported check. The ignore
 *   globs name rolldown's internal code-split chunks — the lazily imported
 *   apple-fm shim module and the intl helpers it pulls in — which are
 *   reachable only through the exported entry bundles, never as exports
 *   entries of their own.
 */

export const config = {
  ignore: ['dist/apple-fm-shim-*.js', 'dist/intl-*.js'],
}
