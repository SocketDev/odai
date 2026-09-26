# Changelog

All notable changes to `@socketsecurity/odai` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2](https://github.com/SocketDev/odai/releases/tag/v0.2.2) - 2026-09-26

### Added

- **`setup`** — provision Chrome model profiles
- **`conversation`** — add persistent sessions and lockstep recovery
- **`lockstep`** — generate patches from anchored changes
- **`bench`** — evaluate caller-defined command intents
- **`ai`** — add bounded local intent classification
- **`bench`** — evaluate caller-defined command intents
- **`ai`** — add bounded local intent classification
- **`lockstep`** — add guarded full and sparse model assistance
- **`cache`** — own Gemma provisioning and Chrome verification
- **`chrome`** — select the on-device model, adding gemma 4
- **`shim`** — serve the OpenAI chat-completions routes beside the Anthropic ones
- **`odai`** — query and cache the model identity, stamping the model name into TaskResult
- **`odai`** — changelog provenance helper + model identity stamped into TaskResult
- **`cli`** — add the pricing extraction task
- **`cli`** — add \`odai serve\` subcommand for the Anthropic Messages shim (#9)

### Changed

- share package chunks and measure persistent context
- **`test`** — separate fast checks and resolve build tools directly
- **`test`** — avoid loading unused model backends

### Fixed

- **`package`** — include source exports in published artifact
- **`cache`** — isolate Gemma scratch browser
- **`test`** — use current partial submodule entrypoint
- **`apple-fm`** — cache shim in macOS user directory
- **`build`** — follow fleet entrypoint module move
- **`release`** — accept odai publish task name
- **`build`** — disable rolldown debug regions
- **`json`** — preserve fenced structured replies
- **`parser`** — harden fenced json extraction
- **`parser`** — harden fenced json extraction
- share prepared Python cache with conformance
- **`repo`** — align conversation checks and coverage reporting
- match Socket coverage badge styling
- **`opencode`** — bring the guard plugin under the lint gate
- **`fuzz`** — match .mts targets and stay quiet on an empty run
- **`workspace`** — drop pnpm settings current pnpm rejects
- **`odai`** — name the page bridge's unknown-session error NotFoundError
- **`odai`** — declare the fleet AST parser devDep so cascaded checks can parse
- **`shim`** — match llama-server route aliases and the completion fingerprint
- **`shim`** — drop an unknown-typed template literal from the chunk test
- **`odai`** — bound the identity probe so a hanging backend degrades instead of stalling
- **`prompts`** — teach pricing extraction the multi-column table shape
- **`cli`** — make serve error messages actionable

### Internal

- **`deps`** — use fleet tool registry and align stable aliases
- **`ci`** — align release workflows with fleet gates
- **`ci`** — reconcile fleet integration
- **`deps`** — reconcile fleet hook lockfile importer
- **`deps`** — reconcile fleet catalog lockfile
- **`ci`** — complete workflow token routing
- **`ci`** — sync hydrated hook lockfile
- **`ci`** — sync hydrated hook lockfile
- **`ci`** — declare benchmark artifacts and verify offline setup
- **`ci`** — use public PR App client ID
- **`ci`** — satisfy release gates
- **`fleet`** — align source type checks and hook boundaries
- **`fleet`** — align source type checks and hook boundaries
- **`deps`** — restore the yaml catalog entry and drop the orphaned pnpm pin

## [0.2.1](https://github.com/SocketDev/odai/releases/tag/v0.2.1) - 2026-08-03

### Added

- **`cli`** — add the batch command — one backend launch, many tasks

### Fixed

- **`cli/batch`** — align catch bindings and remove underscore params in tests
- **`json`** — never repair end-of-stream truncation — give up instead
- **`json`** — repair an unclosed array at the object close, string-aware

### Internal

- **`hooks`** — allowlist dl.google.com for chrome-builtin provisioning
- **`ci`** — neutral sample text — the verify prompt tripped the publish-doctrine scanner
- **`ci`** — make the verify job the lean consumer reference shape
- **`ci`** — cache only the model components + activation state, not profile litter
- **`ci`** — add the on-device model cache fill + offline-verify workflow

## [0.2.0](https://github.com/SocketDev/odai/releases/tag/v0.2.0) - 2026-08-03

### Added

- **`cli`** — wire the dep-update reasoning family into the CLI
- **`llama-server`** — accept portless \*.localhost loopback URLs
- **`odai`** — constrained decoding + generate-verify guardrails
- **`odai`** — best-of-N self-consistency + grounded determinism for decision tasks
- **`odai`** — code-first decision split — model extracts, code decides

### Fixed

- **`release`** — baseline the three unprovenanced odai npm versions
- **`soak`** — drop the unpublishable bare stuie exclude
- **`cli`** — drop the phantom type parameter from parseJsonInput
- **`chrome-builtin`** — call clone and destroy through the session object

### Internal

- **`fleet`** — resync -stable aliases + cascade and lockfile reconcile
- **`deps`** — align nock to the catalog pin + absorb sdk 4.1.3

## [0.1.0](https://github.com/SocketDev/odai/releases/tag/v0.1.0) - 2026-07-29

### Added

- `odai` CLI bin with single-shot subcommands — `summarize`, `commit-msg`, `triage`, `patch`, plus a `backends` availability probe. Parsed JSON on stdout, diagnostics on stderr, a hard per-prompt budget via `--timeout`/`ODAI_TIMEOUT_MS`, and a stable exit-code contract: 0 success, 1 model failure, 2 usage error, 69 no backend available — the clean-skip signal for CI steps, printed with exact provisioning instructions.
- `summarizeText`, `suggestCommitMessage`, and `triageAlerts` tasks alongside the existing patch, dedupe, and lockfile tasks, exported from both entry points.
- Backend registry with `createOdaiModel` and `selectBackend`: backends `simulator`, `gemini-nano-headless`, `llama-server`, and `apple-fm` (declared, unavailable); selection precedence is explicit option, then `ODAI_BACKEND` env var, then availability probe order.
- `llama-server` backend adapter for any OpenAI-compatible `/v1/chat/completions` endpoint: live `GET /health` availability probe, `ODAI_LLAMA_URL` (default `http://127.0.0.1:8080`) and `ODAI_LLAMA_MODEL` config, SSE streaming, and prefill emulation through the existing JSON repair path.
- `gemini-nano-headless` backend bridge: in Node it launches real Google Chrome with `--headless=new` via `playwright-core` (optional peer dependency) and page-proxies the `LanguageModel` global — create, prompt, streaming, clone, destroy — through `page.evaluate`. System-Chrome mode clones the machine's already-downloaded Nano component into a odai-owned profile with copy-on-write (zero weights download, the live Chrome profile is never written; `ODAI_CHROME` overrides the executable). CI mode downloads the component once into a cacheable profile when `ODAI_NANO_ALLOW_DOWNLOAD=1`; `ODAI_NANO_USER_DATA_DIR` pins the profile for `actions/cache`. Chromium builds cannot run Nano — only real Chrome works.
- `bench --backend=<name>` scores any registry backend through the seam; real-model runs put Gemini Nano at 28.6% stable across reruns, 42.9% at best, on the 7-scenario battery.
- Bench reports now include per-scenario prompt latency in milliseconds, recorded by `runEval` and printed by `formatReport`.
- `apple-fm` backend adapter for Apple Foundation Models on macOS 26+: a Swift stdio shim compiled from embedded source with `xcrun swiftc` on first use and cached in `node_modules/.cache/odai/`, honest availability reporting the framework's own reason — `deviceNotEligible`, `appleIntelligenceNotEnabled`, `modelNotReady` — and a `ODAI_APPLE_FM_SHIM` override for prebuilt shims and tests. Single-shot prompting through the existing JSON repair path; streaming yields one chunk in v1.
- Initial fleet onboarding scaffolding.

### Changed

- Renamed the package from `@socketsecurity/gemini-nano` to `@socketsecurity/odai`; the `gnh` evaluation harness is now `bench` — the `./gnh` export and `pnpm run gnh` script are now `./bench` and `pnpm run bench`.

### Fixed

- **`apple-fm`** — move the shim cache out of node\_modules to the repo-root store
