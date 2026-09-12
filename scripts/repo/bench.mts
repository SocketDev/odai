import { isMainModule } from '../fleet/process/is-main-module.mts'
import { runMain } from '../fleet/process/run-main.mts'
import type { ScriptMeta } from '../fleet/process/run-main.mts'

async function main(): Promise<void> {
  const { main: runBenchmark } = await import('../../src/bench/run.mts')
  await runBenchmark()
}

const SCRIPT_META: ScriptMeta = {
  describe: 'runs the Odai benchmark scenarios against one selected backend',
  help: 'Usage: pnpm run bench [--backend <name> | --routed | --mock] [--scenario <name-or-prefix>] [--timeout <ms>] [--json]',
  json: 'native',
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
