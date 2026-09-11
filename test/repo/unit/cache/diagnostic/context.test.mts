import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { writeGemmaDiagnosticContext } from '../../../../../scripts/repo/cache/diagnostic/context.mts'

const roots: string[] = []

async function contextFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gemma-context-'))
  roots.push(directory)
  return {
    directory,
    imageDigest: `sha256:${'ab'.repeat(32)}`,
    sourceRun: '12345',
    result: { signal: 4 },
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await safeDelete(root)
  }
})

test('preserves result and runtime provenance without serializing the environment', async () => {
  const config = await contextFixture()
  await writeGemmaDiagnosticContext(config)
  const value = JSON.parse(
    await fs.readFile(path.join(config.directory, 'metadata.json'), 'utf8'),
  )
  expect(value).toMatchObject({
    imageDigest: config.imageDigest,
    sourceRun: '12345',
    result: { signal: 4 },
    schemaVersion: 1,
  })
  expect(value).toHaveProperty('cpu')
  expect(value).toHaveProperty('memoryEvents')
  expect(value).toHaveProperty('imageModules')
  expect(value).not.toHaveProperty('env')
  expect(value).not.toHaveProperty('environmentVariables')
})

test('refuses replacement and oversized private metadata', async () => {
  const config = await contextFixture()
  await writeGemmaDiagnosticContext(config)
  await expect(writeGemmaDiagnosticContext(config)).rejects.toMatchObject({
    code: 'EEXIST',
  })
  await expect(
    writeGemmaDiagnosticContext({
      ...config,
      result: 'fixture'.repeat(100_000),
    }),
  ).rejects.toThrow()
})
