import path from 'node:path'

import { REPO_ROOT } from '../../../scripts/fleet/paths.mts'
import { isolatedHomeEnv } from '../../fleet/_shared/lib/env.mts'

export const PYTHON_CACHE_ROOT = path.join(
  REPO_ROOT,
  '.cache',
  'repo',
  'conformance',
  'python',
)

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
