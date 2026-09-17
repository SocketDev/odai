import path from 'node:path'

import { PYTHON_CACHE_ROOT } from '../../../scripts/repo/paths.mts'
import { isolatedHomeEnv } from '../../fleet/_shared/lib/env.mts'

/**
 * Keep downloaded tools reusable while each process retains its private home.
 */
export function withIsolatedEnv(
  home: string,
  cacheRoot: string = PYTHON_CACHE_ROOT,
): NodeJS.ProcessEnv {
  return {
    ...isolatedHomeEnv(home),
    UV_CACHE_DIR: path.join(cacheRoot, 'uv'),
    UV_PYTHON_INSTALL_DIR: path.join(cacheRoot, 'install'),
    UV_NO_CONFIG: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONPATH: undefined,
    PYTHONHOME: undefined,
    VIRTUAL_ENV: undefined,
  }
}

/**
 * Pinned upstream test dependencies, shared by preparation and execution.
 */
export const PYTHON_PINS: readonly string[] = [
  'aiohttp==3.9.5',
  'openai==2.14.0',
  'pytest==8.3.5',
  'requests==2.32.3',
  'wget==3.2',
]

export function pythonRunArgs(): string[] {
  const args = ['run', '--no-project', '--python', '3.12']
  for (let index = 0, { length } = PYTHON_PINS; index < length; index += 1) {
    args.push('--with', PYTHON_PINS[index]!)
  }
  return args
}
