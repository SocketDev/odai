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

const outputs = [
  'odai-logomark-light.svg',
  'odai-logomark-dark.svg',
  'odai-combomark.svg',
  'odai-combomark-light.svg',
  'odai-combomark-dark.svg',
]
for (let i = 0, { length } = outputs; i < length; i += 1) {
  writeFileSync(path.join(BRAND_DIR, outputs[i] as string), mark)
}
logger.log(
  `gen-combomark: wrote ${outputs.join(', ')} — the all-in-one badge, one set of bytes`,
)
