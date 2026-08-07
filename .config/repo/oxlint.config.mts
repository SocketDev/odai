/**
 * @file Repo overlay over the fleet oxlint config. The `--type-aware`
 *   tsgolint lane the fleet lint runner's whole-tree gate turned on is staged
 *   OFF rule-by-rule here, mirroring socket-registry's and socket-sdk-js's
 *   adoption overlays. First enforcement surfaced ~90 pre-existing findings
 *   concentrated in the backend seam and its tests: the seam narrows untyped
 *   engine payloads (page-proxy replies, shim protocol JSON, OpenAI-compatible
 *   response bodies) via `as` casts by design, the fuzz lanes spread ASCII
 *   corpus strings deliberately, and the Swift-shim error surfaces stringify
 *   `unknown` protocol fields. Burn the debt down rule-by-rule, deleting
 *   entries here as each rule reaches zero findings — the fleet
 *   lint-modernization campaign owns the sweep. This is a REPO-SPECIFIC
 *   concern, so it lives in `.config/repo/` (auto-discovered by the fleet lint
 *   runner, which prefers a repo overlay over the fleet canonical), NOT in the
 *   cascaded fleet config.
 */

import { defineConfig } from 'oxlint'

import { config } from '../fleet/oxlint.config.mts'

// oxlint loads the config from this module's default export.
// oxlint-disable-next-line socket/no-default-export -- oxlint config contract
export default defineConfig(
  config({
    rules: {
      // Brand-new socket/* rule from the plugin sync: the seam's public
      // helper signatures keep their published `options` param names —
      // renaming to `config` is an API-shape change that needs its own
      // reviewed pass, not a lint sweep.
      'socket/bag-param-optionality-naming': 'off',
      // The Swift-shim protocol replies are line-delimited JSON `unknown`s;
      // the error surfaces stringify them on purpose to keep the raw enum
      // token greppable.
      'typescript/no-base-to-string': 'off',
      // The fuzz lanes spread ASCII corpus strings into character arrays
      // deliberately; no emoji-bearing input exists in those corpora.
      'typescript/no-misused-spread': 'off',
      // The seam narrows untyped engine payloads (page-proxy replies, shim
      // JSON, OpenAI-compatible bodies) and tests fake those boundaries via
      // `as` casts by design (66 sites at first enforcement).
      'typescript/no-unsafe-type-assertion': 'off',
    },
  }),
)
