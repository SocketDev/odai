import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

export interface GemmaArchiveLimits {
  maxBytes?: number | undefined
  maxEntries?: number | undefined
}

const ARCHIVE_AUDIT = String.raw`
import gzip
import io
import json
import re
import sys
import tarfile

archive, max_bytes, max_entries = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
required = {'image-id', 'image.tar', 'profile/odai-cache.html', 'seccomp.json'}
seen = set()
entry_count = 0

class LimitedReader(io.RawIOBase):
    def __init__(self, source):
        self.source = source
        self.total = 0
    def readable(self):
        return True
    def readinto(self, destination):
        size = self.source.readinto(destination)
        self.total += size
        if self.total > max_bytes:
            raise ValueError('too many expanded bytes')
        return size

with gzip.open(archive, 'rb') as compressed:
    reader = LimitedReader(compressed)
    stream = io.BufferedReader(reader)
    with tarfile.open(fileobj=stream, mode='r|') as source:
        for member in source:
            entry_count += 1
            if entry_count > max_entries:
                raise ValueError('too many entries')
            name = member.name.removeprefix('./').removesuffix('/')
            segments = name.split('/')
            if member.name.startswith('/') or '\\' in name or re.match(r'^[a-zA-Z]:', name) or '..' in segments:
                raise ValueError('unsafe path: ' + name)
            if any(part.startswith('._') or part in ('__MACOSX', '.AppleDouble') for part in segments):
                raise ValueError('platform metadata path: ' + name)
            if not (member.isfile() or member.isdir()):
                raise ValueError('non-regular entry: ' + name)
            if name not in ('.', 'image-id', 'image.tar', 'seccomp.json', 'profile') and not name.startswith('profile/'):
                raise ValueError('unexpected path: ' + name)
            if name in seen or ('.' in segments and name != '.') or '' in segments:
                raise ValueError('duplicate or non-canonical path: ' + name)
            if member.size < 0 or member.size > max_bytes:
                raise ValueError('invalid entry size: ' + name)
            seen.add(name)
            if member.isfile():
                required.discard(name)
    while stream.read(65536):
        pass
if required:
    raise ValueError('missing required files: ' + ', '.join(sorted(required)))
print(json.dumps({'entryCount': entry_count, 'expandedBytes': reader.total}))
`

export async function auditGemmaArchive(
  archivePath: string,
  limits: GemmaArchiveLimits = {},
) {
  const maxBytes = limits.maxBytes ?? 16 * 1024 ** 3
  const maxEntries = limits.maxEntries ?? 10_000
  if (
    ![maxBytes, maxEntries].every(
      value => Number.isSafeInteger(value) && value > 0,
    )
  ) {
    throw new Error(
      'Invalid Gemma archive limits. Saw non-positive or unsafe limits; expected positive safe integers. Correct the audit limits and retry.',
    )
  }
  const result = await spawn(
    'python3',
    ['-c', ARCHIVE_AUDIT, archivePath, String(maxBytes), String(maxEntries)],
    { timeout: 600_000, throws: false },
  )
  if (result.code !== 0) {
    throw new Error(
      `Gemma archive audit failed at ${archivePath}. Saw ${String(result.stderr).trim() || `exit ${result.code}`}; expected a bounded portable gzip tar archive. Rebuild without metadata, links, or unsafe paths; ensure Python 3 is installed.`,
    )
  }
  const data: unknown = JSON.parse(String(result.stdout))
  if (
    !data ||
    typeof data !== 'object' ||
    !('entryCount' in data) ||
    !('expandedBytes' in data) ||
    !Number.isSafeInteger(data.entryCount) ||
    !Number.isSafeInteger(data.expandedBytes)
  ) {
    throw new Error(
      'Gemma archive audit returned an invalid receipt. Saw missing measurements; expected entry and byte counts. Check the Python runtime and retry.',
    )
  }
  return {
    __proto__: null,
    entryCount: data.entryCount as number,
    expandedBytes: data.expandedBytes as number,
  }
}
