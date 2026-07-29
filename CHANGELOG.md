# Changelog

All notable changes to `@socketsecurity/odai` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
