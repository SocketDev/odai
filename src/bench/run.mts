import { parseArgs as parseNodeArgs } from 'node:util'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { createChromeBuiltinBackend } from '../backends/chrome-builtin.mts'
import { createSimulatorBackend } from '../backends/simulator.mts'
import { createBackend, isBackendName } from '../backends/registry.mts'
import { closeBackend, withTimeout } from '../cli/run.mts'
import { isMainModule } from '../is-main-module.mts'
import { createOdaiModel, destroySession } from '../model.mts'
import { createMockModel } from '../mock.mts'
import { preferredTaskBackend } from '../routing.mts'
import { allScenarios, formatReport, runEval } from './index.mts'
import { createBenchResponseRules } from './simulator.mts'
import type { BackendName, OdaiBackend } from '../backends/types.mts'
import type { OdaiModel } from '../model.mts'

export const logger = getDefaultLogger()

export function benchmarkEvidence(
  args: Pick<RunArgs, 'mock' | 'backend' | 'routed'>,
): 'real' | 'simulator' | 'unverified' {
  if (
    args.mock ||
    args.backend === 'simulator' ||
    (!args.backend && !args.routed)
  ) {
    return 'simulator'
  }
  return args.routed ? 'unverified' : 'real'
}

export interface RunArgs {
  __proto__?: null | undefined
  backend: BackendName | undefined
  help: boolean
  json: boolean
  mock: boolean
  routed: boolean
  scenario: string | undefined
  timeoutMs: number
}

export function parseArgs(argv: string[]): RunArgs {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      backend: { type: 'string' },
      describe: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      mock: { type: 'boolean' },
      routed: { type: 'boolean' },
      scenario: { type: 'string' },
      timeout: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.backend !== undefined && !isBackendName(values.backend)) {
    throw new Error(
      `Backend ${values.backend} is not declared. Use odai backends to list engines.`,
    )
  }
  const timeoutMs = Number(values.timeout ?? 120_000)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Timeout must be positive milliseconds.')
  }
  if (
    Number(Boolean(values.mock)) +
      Number(Boolean(values.routed)) +
      Number(values.backend !== undefined) >
    1
  ) {
    throw new Error('Select one of --mock, --routed, or --backend.')
  }
  return {
    __proto__: null,
    backend: values.backend,
    help: Boolean(values.help || values.describe),
    json: values.json ?? false,
    mock: values.mock ?? false,
    routed: values.routed ?? false,
    scenario: values.scenario,
    timeoutMs,
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArgs(argv)
  if (args.help) {
    logger.log(
      'Usage: pnpm run bench [--backend <name> | --routed | --mock] [--scenario <name-or-prefix>] [--timeout <ms>] [--json]. Default: deterministic simulator. --routed uses task routing. --backend chrome-builtin evaluates the local Chrome model. Timeout bounds each scenario and backend creation.',
    )
    return
  }
  const scenarios =
    args.scenario === undefined
      ? allScenarios
      : allScenarios.filter(scenario =>
          scenario.name.startsWith(args.scenario!),
        )
  if (scenarios.length === 0) {
    throw new Error(
      `No scenarios match ${args.scenario}. Use lockstep for both materializations.`,
    )
  }
  const opened: Array<{ backend: OdaiBackend; model: OdaiModel }> = []
  async function acquire(name: BackendName): Promise<OdaiModel> {
    const existing = opened.find(entry => entry.backend.name === name)
    if (existing) {
      return existing.model
    }
    const backend =
      name === 'simulator'
        ? createSimulatorBackend({ rules: createBenchResponseRules() })
        : name === 'chrome-builtin'
          ? createChromeBuiltinBackend({ readyTimeoutMs: args.timeoutMs })
          : createBackend(name)
    try {
      const model = await withTimeout(
        createOdaiModel({ backend, temperature: 0, topK: 1 }),
        args.timeoutMs,
        `odai bench ${name} setup`,
      )
      opened.push({ backend, model })
      return model
    } catch (error) {
      await closeBackend(backend)
      throw error
    }
  }
  try {
    const model = args.mock
      ? createMockModel('{}')
      : await acquire(
          args.backend ??
            (args.routed
              ? (preferredTaskBackend([
                  scenarios[0]!.task ?? scenarios[0]!.name,
                ]) ?? 'chrome-builtin')
              : 'simulator'),
        )
    const report = await runEval({
      model,
      evidence: benchmarkEvidence(args),
      identifyModel: true,
      scenarios: scenarios.map(scenario => ({
        __proto__: null,
        ...scenario,
        run: nextModel =>
          withTimeout(
            scenario.run(nextModel),
            args.timeoutMs,
            `odai bench ${scenario.name}`,
          ),
      })),
      ...(args.routed
        ? {
            modelForScenario: (scenario: (typeof scenarios)[number]) =>
              acquire(
                preferredTaskBackend([scenario.task ?? scenario.name]) ??
                  'chrome-builtin',
              ),
          }
        : {}),
    })
    logger.log(args.json ? JSON.stringify(report) : formatReport(report))
    process.exitCode = report.passed === report.total ? 0 : 1
  } finally {
    for (let index = 0, length = opened.length; index < length; index += 1) {
      const entry = opened[index]!
      destroySession(entry.model.rawSession())
      await closeBackend(entry.backend)
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.fail(error)
    process.exitCode = 1
  })
}
