import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'

import { fetchChangelog } from '../src/changelog.mts'

const httpRequestMock = vi.hoisted(() => vi.fn())
vi.mock(import('@socketsecurity/lib-stable/http-request'), () => ({
  httpRequest: httpRequestMock,
}))

function jsonResponse(status: number, payload: unknown) {
  return { body: Buffer.from(JSON.stringify(payload), 'utf8'), status }
}

describe('fetchChangelog', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'odai-changelog-'))
  })

  afterEach(async () => {
    await safeDelete(dir)
    httpRequestMock.mockReset()
  })

  it('prefers the installed CHANGELOG.md and labels the source', async () => {
    mkdirSync(path.join(dir, 'node_modules', 'some-lib'), { recursive: true })
    writeFileSync(
      path.join(dir, 'node_modules', 'some-lib', 'CHANGELOG.md'),
      '# Changelog\n\n## 2.0.0\nDropped old Node.',
    )
    const result = await fetchChangelog('some-lib', { root: dir })
    expect(result.source).toBe('local-changelog')
    expect(result.text).toContain('Dropped old Node')
    expect(httpRequestMock).not.toHaveBeenCalled()
  })

  it('falls back to the registry README for the target version', async () => {
    httpRequestMock.mockResolvedValue(
      jsonResponse(200, {
        readme: '# some-lib',
        versions: { '2.0.0': { readme: '# some-lib 2.0 release notes' } },
      }),
    )
    const result = await fetchChangelog('some-lib', { version: '2.0.0' })
    expect(result.source).toBe('registry-readme')
    expect(result.text).toContain('2.0 release notes')
  })

  it('reports none when neither source exists', async () => {
    httpRequestMock.mockResolvedValue(jsonResponse(404, {}))
    const result = await fetchChangelog('missing-lib', { root: dir })
    expect(result).toEqual({ source: 'none', text: '' })
  })

  it('reports none on a network failure without throwing', async () => {
    httpRequestMock.mockRejectedValue(new Error('offline'))
    const result = await fetchChangelog('some-lib', { root: dir })
    expect(result).toEqual({ source: 'none', text: '' })
  })
})
