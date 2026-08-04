#!/usr/bin/env node
/*
 * @file Reproducible generator for the odai combination mark — CODE IS LAW.
 *   The badge is all-in-one: the shield carries the odai wordmark, the
 *   on disk AI tagline, SOCKET LABS, and the storage layers. The combomark IS
 *   the committed logomark, re-emitted byte-identically for every variant
 *   slot. The badge paints an opaque white field inside the shield, so light
 *   and dark are the same bytes. Deterministic function of the committed
 *   source SVG — same bytes in, same bytes out.
 *
 *   CLI: node scripts/repo/gen-combomark.mts writes
 *   assets/repo/brand/odai-combomark and the variant slots.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

const logger = getDefaultLogger()
const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRAND_DIR = path.join(HERE, '..', '..', 'assets', 'repo', 'brand')

const mark = readFileSync(path.join(BRAND_DIR, 'odai-logomark.svg'), 'utf8')
if (!mark.includes('<svg') || !mark.includes('<path')) {
  logger.fail(
    'gen-combomark: expected the committed logomark to be a drawable SVG.\n' +
      `  Where: ${path.join(BRAND_DIR, 'odai-logomark.svg')}\n` +
      '  Saw: no svg or path content; wanted the committed odai badge vector.\n' +
      '  Fix: restore assets/repo/brand/odai-logomark.svg from git.',
  )
  process.exit(1)
}

// ONE adaptive output. This used to write five filenames from the same bytes,
// so `-light` and `-dark` were the identical file and the README's <picture>
// switched between two copies of one image.
//
// A theme split earns its keep only when a mark has a single-ink layer that
// disappears against the opposite background — the Socket combomark needs it
// because its wordmark is `#1a1338`, invisible on dark. This badge has no such
// layer: it is a full-colour illustration (purple gradients over `#260e61`,
// with a `#fff` highlight that is a <path> inside the artwork, not a
// background plate), so it reads on any surface. The canonical grammar already
// allows for this — `<variant>` is documented as optional, "the theme-split of
// an adaptive mark", and the unsuffixed name IS the adaptive form.
const OUTPUT = 'odai-combomark.svg'
writeFileSync(path.join(BRAND_DIR, OUTPUT), mark)
logger.log(
  `gen-combomark: wrote ${OUTPUT} — one adaptive badge, no theme split`,
)
