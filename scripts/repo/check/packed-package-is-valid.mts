/**
 * @file Check the packed runtime and declarations in an isolated consumer.
 */

import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  symlink,
} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { runInNewContext } from 'node:vm'

import { extractTarGz } from '@socketsecurity/lib-stable/archives/tar'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { rolldown } from 'rolldown'

import { REPO_ROOT } from '../../fleet/paths.mts'
import { isMainModule } from '../../fleet/process/is-main-module.mts'
import { runMain } from '../../fleet/process/run-main.mts'

export interface PackageCheckResult {
  browser: boolean
  runtime: boolean
  types: boolean
}

export async function preparePackageConsumer(
  temporaryRoot: string,
): Promise<string> {
  await spawn(
    'npm',
    [
      'pack',
      '--force',
      '--ignore-scripts',
      '--pack-destination',
      temporaryRoot,
    ],
    { cwd: REPO_ROOT },
  )
  const archives = (await readdir(temporaryRoot)).filter(name =>
    name.endsWith('.tgz'),
  )
  if (archives.length !== 1) {
    throw new Error(
      'Package check expected one tarball. Run pnpm run build and retry pnpm run check:package.',
    )
  }
  const packageRoot = path.join(
    temporaryRoot,
    'node_modules',
    '@socketsecurity',
    'odai',
  )
  await extractTarGz(path.join(temporaryRoot, archives[0]!), packageRoot, {
    strip: 1,
  })
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string> | undefined
  }
  const dependencies = Object.keys(manifest.dependencies ?? {})
  for (const name of [...dependencies, '@types/node']) {
    const destination = path.join(temporaryRoot, 'node_modules', name)
    await mkdir(path.dirname(destination), { recursive: true })
    await symlink(
      await realpath(path.join(REPO_ROOT, 'node_modules', name)),
      destination,
      'dir',
    )
  }
  const fixtures = path.join(
    REPO_ROOT,
    'test',
    'repo',
    'integration',
    'fixture',
    'package',
  )
  const copied = await Promise.allSettled(
    ['browser.mts', 'consumer.mts'].map(name =>
      copyFile(path.join(fixtures, name), path.join(temporaryRoot, name)),
    ),
  )
  for (const result of copied) {
    if (result.status === 'rejected') {
      throw result.reason
    }
  }
  return temporaryRoot
}

export async function checkPackageTypes(consumerRoot: string): Promise<void> {
  await spawn(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--target',
      'esnext',
      '--lib',
      'esnext,dom,dom.iterable',
      '--strict',
      '--skipLibCheck',
      'false',
      '--noEmitOnError',
      '--types',
      'node',
      '--typeRoots',
      path.join(consumerRoot, 'node_modules', '@types'),
      '--outDir',
      path.join(consumerRoot, 'compiled'),
      path.join(consumerRoot, 'consumer.mts'),
      path.join(consumerRoot, 'browser.mts'),
    ],
    { cwd: consumerRoot, stdio: 'inherit' },
  )
}

export async function checkBrowserPackage(consumerRoot: string): Promise<void> {
  const bundle = await rolldown({
    input: path.join(consumerRoot, 'browser.mts'),
    platform: 'browser',
    onwarn(warning) {
      throw new Error(warning.message)
    },
  })
  try {
    const result = await bundle.generate({
      format: 'iife',
      name: 'odaiConsumer',
      codeSplitting: false,
    })
    const entry = result.output.find(
      chunk => chunk.type === 'chunk' && chunk.isEntry,
    )
    if (entry?.type !== 'chunk') {
      throw new Error('Browser consumer build emitted no entry chunk.')
    }
    const passed: unknown = await runInNewContext(
      `${entry.code}\nodaiConsumer.runBrowserSmoke()`,
      {
        AbortController,
        AbortSignal,
        atob,
        clearTimeout,
        console,
        DOMException,
        performance,
        ReadableStream,
        setTimeout,
        structuredClone,
        TextDecoder,
        TextEncoder,
      },
      { timeout: 5000 },
    )
    if (passed !== true) {
      throw new Error(
        'Packed browser helpers failed the structured prompt. Fix the browser bundle and rerun pnpm run check:package.',
      )
    }
  } finally {
    await bundle.close()
  }
}

export async function checkPackedPackage(): Promise<PackageCheckResult> {
  await spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts/repo/build.mts')],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    },
  )
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'odai-package-'))
  try {
    const consumerRoot = await preparePackageConsumer(temporaryRoot)
    await checkPackageTypes(consumerRoot)
    await spawn(
      process.execPath,
      [path.join(consumerRoot, 'compiled', 'consumer.mjs')],
      {
        cwd: consumerRoot,
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      },
    )
    await checkBrowserPackage(consumerRoot)
    return { browser: true, runtime: true, types: true }
  } finally {
    await safeDelete(temporaryRoot)
  }
}

const SCRIPT_META = {
  describe:
    'Build and verify the packed package in isolated Node, browser, and TypeScript consumers.',
  help: 'Usage: pnpm run check:package',
  json: 'result',
} as const

if (isMainModule(import.meta.url)) {
  runMain(async () => {
    await checkPackedPackage()
  }, SCRIPT_META)
}
