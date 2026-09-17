# Automation practices

Odai automation must work without an agent deciding which command to run next. A script discovers its supported inputs, checks the local state, performs bounded work, verifies the result, and reports a specific repair when it cannot continue. Public entrypoints support machine-readable output and return a nonzero exit code for an incomplete result.

Use deterministic code before asking a model. Formatting, linting, type checks, dependency checks, path checks, cache capacity, browser discovery, profile creation, model availability, and cleanup have exact answers. Model calls are appropriate for bounded semantic work such as summarizing text or choosing among validated lockstep changes. The caller validates every model result before applying it.

Hooks protect commands through deterministic parsing and policy checks. A hook must not start Odai to decide whether a command is allowed. Model-backed repair remains an explicit command after an ordinary checker has produced a bounded diagnostic.

The installed package owns Chrome setup through `odai setup` and `setupChromeBuiltin()`. Setup finds Chrome, creates the dedicated profile, permits the requested model download, waits for readiness, verifies model identity, closes its resources, and returns a JSON receipt. A package consumer may provide `reclaimStorage` for application-owned cleanup. Odai invokes it only after measuring a capacity deficit, then measures again before Chrome starts.

Repository model setup calls the same public setup API. It passes the measured storage-recovery callback and verifies identity even when component files already exist. Readiness checks return a nonzero exit code when a requested prerequisite is missing.

Repository provisioning may use the fleet Rust target sweep because the repository knows that stale Rust build outputs are disposable. Published library code does not assume that a consumer has Rust projects or Wheelhouse scripts.

Tests use temporary homes for spawned tools. Python setup and conformance share downloaded packages and Python installations under `.cache/repo/python/`. The shared Python helper owns the version, dependency arguments, and isolated environment. It imports the cache root from `scripts/repo/paths.mts` and sets these paths after clearing personal cache overrides. Both commands disable project discovery so their working directories cannot change the selected Python project. Conformance still writes test files, reports, and home configuration inside its temporary staging directory. Clearing the shared cache requires running `pnpm run setup:e2e --conformance` again to warm it. Package validation creates a temporary consumer and uses `npm pack`, which avoids a dependency on Corepack's pnpm shim. The fleet entrypoint and isolation checks enforce these contracts.

## Verify prepared Python caches

Run setup once, then require the conformance runner to resolve Python dependencies offline:

```sh
pnpm run setup:e2e --conformance
UV_OFFLINE=1 pnpm run test:conformance
```

The offline setting applies to `uv`. The conformance tests still contact the local shim server. A missing cached dependency must fail instead of downloading during this check.

The verified run reported 5 passing cases, 75 expected failures, and no unexpected failures. Expected failures describe unsupported upstream behavior. They are separate from dependency preparation and do not count as passing cases.

## Automation boundaries

| Entrypoint                               | Deterministic responsibility                                                              | Model use                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Package preparation                      | Hydrate the fleet payload, verify dependencies, and install generated tooling.            | None.                                                  |
| Hooks, lint, formatting, and type checks | Parse inputs and enforce declared rules.                                                  | None for pass or fail decisions.                       |
| `setup:e2e --conformance`                | Prepare the pinned upstream files and shared Python dependencies.                         | None.                                                  |
| `setup:e2e --check`                      | Check browser and component files, then verify Python dependencies offline.               | None.                                                  |
| `odai setup` and repository model setup  | Prepare the owned Chrome profile and verify readiness.                                    | One identity probe after preparation.                  |
| Packed-package checks                    | Build and install the package in an isolated consumer, then exercise its exports.         | Deterministic providers.                               |
| Lockstep assistance                      | Validate evidence, restrict edits, construct patches, and reject invalid proposals.       | Bounded proposal generation.                           |
| Conversation comparisons                 | Alternate retained and replay sessions with identical history and validate each response. | Live generation, with failures retained in the report. |

Fleet-owned workflow and hook changes belong in Wheelhouse. A passing Odai test suite does not establish that those independent fleet checks pass.
