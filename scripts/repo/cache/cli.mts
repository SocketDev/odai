import process from 'node:process'
import { runMain } from '../../fleet/process/run-main.mts'
import type { ScriptMeta } from '../../fleet/process/run-main.mts'

export interface CacheScriptMeta extends ScriptMeta {
  json?: 'result' | undefined
}

export interface CacheCommandResult {
  exitCode: number
  data?: unknown | undefined
}

export function getCacheArgs(): string[] {
  return process.argv.slice(2).filter(argument => argument !== '--json')
}

export function runCacheMain(
  main: () => Promise<CacheCommandResult>,
  meta: CacheScriptMeta,
): void {
  runMain(async () => {
    const result = await main()
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
    return result.exitCode
  }, meta)
}
