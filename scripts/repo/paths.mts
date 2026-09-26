import path from 'node:path'

import { REPO_ROOT } from '../fleet/paths.mts'

export * from '../fleet/paths.mts'

export const PYTHON_CACHE_ROOT = path.join(
  REPO_ROOT,
  '.cache',
  'repo',
  'python',
)
