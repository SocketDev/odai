import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'

import { withIsolatedEnv } from '../../../../scripts/llama-cpp-server/environment.mts'

it('reuses setup downloads across private conformance homes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'odai-python-cache-'))
  try {
    const cacheRoot = path.join(root, 'cache')
    const setup = withIsolatedEnv(path.join(root, 'setup'), cacheRoot)
    const run = withIsolatedEnv(path.join(root, 'run'), cacheRoot)
    for (const key of ['UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR']) {
      const directory = setup[key]!
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'prepared'), 'ready')
      expect(await readFile(path.join(run[key]!, 'prepared'), 'utf8')).toBe(
        'ready',
      )
    }
    expect(run['HOME']).not.toBe(setup['HOME'])
    expect(run['XDG_CONFIG_HOME']).not.toBe(setup['XDG_CONFIG_HOME'])
    expect(withIsolatedEnv('setup')['UV_CACHE_DIR']).toBe(
      withIsolatedEnv('run')['UV_CACHE_DIR'],
    )
    expect(withIsolatedEnv('setup')['UV_PYTHON_INSTALL_DIR']).toBe(
      withIsolatedEnv('run')['UV_PYTHON_INSTALL_DIR'],
    )
  } finally {
    await safeDelete(root)
  }
})

it('overrides ambient Python caches and configuration without changing the parent', () => {
  vi.stubEnv('UV_CACHE_DIR', '/personal/cache')
  vi.stubEnv('UV_PYTHON_INSTALL_DIR', '/personal/python')
  try {
    const env = {
      ...process.env,
      ...withIsolatedEnv('/private/home', '/owned/cache'),
    }
    expect(env['UV_CACHE_DIR']).toBe(path.join('/owned/cache', 'uv'))
    expect(env['UV_PYTHON_INSTALL_DIR']).toBe(
      path.join('/owned/cache', 'install'),
    )
    expect(env['UV_NO_CONFIG']).toBe('1')
    expect(env['PYTHONNOUSERSITE']).toBe('1')
    expect(env['VIRTUAL_ENV']).toBeUndefined()
    expect(env['PYTHONPATH']).toBeUndefined()
    expect(process.env['UV_CACHE_DIR']).toBe('/personal/cache')
  } finally {
    vi.unstubAllEnvs()
  }
})
