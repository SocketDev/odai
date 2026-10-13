# API Reference

The package exports a browser entrypoint, a Node entrypoint, and a benchmark subpath. The package export map in [`package.json`](../package.json) identifies their declarations. The browser entrypoint is `@socketsecurity/odai`; Node-only tasks, CLI functions, setup, and server integration are available from `@socketsecurity/odai/node`.

## Main model API

The main entrypoint exports model factories, task helpers, backend selection, and control-token utilities from [`src/index.mts`](../src/index.mts).

| Export                                                                      | Declaration                                                          |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `createOdaiModel`                                                           | [Model construction and options](../src/model.mts)                   |
| `createBuiltinModel`                                                        | [Browser built-in model factory](../src/model.mts)                   |
| `probeBackendAvailability`                                                  | [Backend availability result](../src/availability.mts)               |
| `createBackend`, `selectBackend`, `backendNames`, `defaultProbeOrder`       | [Backend registry](../src/backends/registry.mts)                     |
| `createChromeBuiltinBackend`                                                | [Chrome built-in backend](../src/backends/chrome-builtin.mts)        |
| `createAppleFmBackend`                                                      | [Apple Foundation Models backend](../src/backends/apple-fm.mts)      |
| `createLlamaServerBackend`                                                  | [llama-server backend](../src/backends/llama-server.mts)             |
| `createSimulatorBackend`                                                    | [Simulator backend](../src/backends/simulator.mts)                   |
| `createWindowsPhiSilicaBackend`                                             | [Windows Phi Silica backend](../src/backends/windows-phi-silica.mts) |
| `classifyDependencyChange`, `classifyReleaseBump`, `dedupeDependencies`     | [Dependency task implementations](../src/tasks/classify-deps.mts)    |
| `assessHoistSafety`, `decideHoistVerdict`                                   | [Hoist task](../src/tasks/hoist.mts)                                 |
| `assessSecurityFix`, `decideSecurityFix`                                    | [Security-fix task](../src/tasks/security-fix.mts)                   |
| `generateCodePatch`                                                         | [Patch task](../src/tasks/patch.mts)                                 |
| `reasonAboutLockfile`, `analyzeLockstep`                                    | [Lockfile and lockstep tasks](../src/tasks/lockfile.mts)             |
| `summarizeText`, `triageAlerts`, `suggestCommitMessage`                     | [Text and finding tasks](../src/tasks/summarize.mts)                 |
| `createConversation`, `createBuiltinConversation`, `createOdaiConversation` | [Conversation entrypoints](../src/conversation/create.mts)           |
| `CONTROL_TOKENS`, `formatControlTokens`, `parseControlTokens`               | [Control-token protocol](../src/control-tokens.mts)                  |

Function signatures, option fields, return types, and validation rules are documented in the linked declarations. The browser entrypoint does not export Node built-ins.

## Node API

The Node subpath exports task and prompt helpers, backend interfaces, CLI execution, Chrome setup, and conversation lifecycle helpers from [`src/node.mts`](../src/node.mts).

| Export group                                                        | Source                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `runCli`, `runBatchEntries`, `parseBatchManifest`                   | [CLI runtime](../src/cli/run.mts) and [batch parser](../src/cli/batch.mts)                  |
| `setupChromeBuiltin`                                                | [Chrome setup](../src/backends/chrome/setup.mts)                                            |
| `withOdaiModel`                                                     | [Model lifecycle](../src/lifecycle.mts)                                                     |
| `createMockModel`, `createMockSession`, `LanguageModelSimulator`    | [Explicit simulators](../src/mock.mts) and [simulator implementation](../src/simulator.mts) |
| `createKevClient`, `assertKevLoopbackUrl`                           | [KEV client](../src/kev/client.mts)                                                         |
| `analyzeLockstep`, `parseLockstepInput`, `validateLockstepAnalysis` | [Lockstep operations](../src/tasks/lockstep.mts)                                            |

The same `src/node.mts` declaration lists Node-only option and result types. The package's [`types/`](../types/) directory provides the published API contract and helpers for consumers that need standalone type imports.

## Benchmark API

The `@socketsecurity/odai/bench` subpath exports `allScenarios`, `runEval`, `formatReport`, and the `EvalRunOptions`, `EvalReport`, `Scenario`, and `ScenarioResult` types. See [`src/bench/index.mts`](../src/bench/index.mts) for the signatures. Evaluation can use the simulator or a supplied model; report evidence identifies whether results came from a real backend, simulator, or unverified source.

## Runtime behavior and related references

- See the [command reference](./commands.md) for the CLI command set, input forms, and exit codes.
- See the [service reference](./service.md) for loopback HTTP routes and client compatibility.
- See the [keyless CI guide](./keyless-ci-ai.md) for backend provisioning and unattended use.
