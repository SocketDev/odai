import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

export interface ByteLengths {
  raw: number
  gzip: number
  brotli: number
}

export function compressBytes(content: string | Uint8Array) {
  const raw =
    typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.from(content)
  return {
    __proto__: null,
    raw,
    gzip: gzipSync(raw, { level: 9 }),
    brotli: brotliCompressSync(raw, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }),
  }
}

export function measureBytes(content: string | Uint8Array): ByteLengths {
  const compressed = compressBytes(content)
  return {
    __proto__: null,
    raw: compressed.raw.byteLength,
    gzip: compressed.gzip.byteLength,
    brotli: compressed.brotli.byteLength,
  } as ByteLengths
}
