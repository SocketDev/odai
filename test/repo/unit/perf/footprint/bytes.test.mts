import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { expect, test } from 'vitest'

import {
  compressBytes,
  measureBytes,
} from '../../../../../scripts/repo/perf/footprint/bytes.mts'

test('measures UTF-8 bytes and produces lossless compressed representations', () => {
  const text = 'const greeting = "你好 🌍";\n'.repeat(100)
  const encoded = Buffer.from(text, 'utf8')
  const compressed = compressBytes(text)
  expect(compressed.raw).toEqual(encoded)
  expect(gunzipSync(compressed.gzip)).toEqual(encoded)
  expect(brotliDecompressSync(compressed.brotli)).toEqual(encoded)
  expect(measureBytes(text)).toEqual({
    raw: encoded.byteLength,
    gzip: compressed.gzip.byteLength,
    brotli: compressed.brotli.byteLength,
  })
  expect(compressed.gzip.byteLength).toBeLessThan(encoded.byteLength)
  expect(compressed.brotli.byteLength).toBeLessThan(encoded.byteLength)
})

test('preserves arbitrary binary assets and deterministic encodings', () => {
  const source = Uint8Array.from([0, 255, 128, 64, 0, 10])
  const compressed = compressBytes(source)
  expect(gunzipSync(compressed.gzip)).toEqual(Buffer.from(source))
  expect(brotliDecompressSync(compressed.brotli)).toEqual(Buffer.from(source))
  expect(compressBytes(source)).toEqual(compressed)
})
