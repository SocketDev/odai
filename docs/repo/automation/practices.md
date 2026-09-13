# Automation practices

Odai automation must work without an agent deciding which command to run next. A script discovers its supported inputs, checks the local state, performs bounded work, verifies the result, and reports a specific repair when it cannot continue. Public entrypoints support machine-readable output and return a nonzero exit code for an incomplete result.

Use deterministic code before asking a model. Formatting, linting, type checks, dependency checks, path checks, cache capacity, browser discovery, profile creation, model availability, and cleanup have exact answers. Model calls are appropriate for bounded semantic work such as summarizing text or choosing among validated lockstep changes. The caller validates every model result before applying it.

Hooks protect commands through deterministic parsing and policy checks. A hook must not start Odai to decide whether a command is allowed. Model-backed repair remains an explicit command after an ordinary checker has produced a bounded diagnostic.

The installed package owns Chrome setup through `odai setup` and `setupChromeBuiltin()`. Setup finds Chrome, creates the dedicated profile, permits the requested model download, waits for readiness, verifies model identity, closes its resources, and returns a JSON receipt. A package consumer may provide `reclaimStorage` for application-owned cleanup. Odai invokes it only after measuring a capacity deficit, then measures again before Chrome starts.

Repository provisioning may use the fleet Rust target sweep because the repository knows that stale Rust build outputs are disposable. Published library code does not assume that a consumer has Rust projects or Wheelhouse scripts.

Tests use temporary homes and caches for spawned tools. Package validation creates a temporary consumer and uses `npm pack`, which avoids a dependency on Corepack's pnpm shim. The fleet entrypoint and isolation checks enforce these contracts.
