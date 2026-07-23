# Changelog

All notable changes to `@socketsecurity/locai` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Backend registry with `createLocaiModel` and `selectBackend`: backends `simulator`, `gemini-nano-headless`, `llama-server`, and `apple-fm` (declared, unavailable); selection precedence is explicit option, then `LOCAI_BACKEND` env var, then availability probe order.
- `llama-server` backend adapter for any OpenAI-compatible `/v1/chat/completions` endpoint: live `GET /health` availability probe, `LOCAI_LLAMA_URL` (default `http://127.0.0.1:8080`) and `LOCAI_LLAMA_MODEL` config, SSE streaming, and prefill emulation through the existing JSON repair path.
- `gemini-nano-headless` backend bridge: in Node it launches real Google Chrome with `--headless=new` via `playwright-core` (optional peer dependency) and page-proxies the `LanguageModel` global — create, prompt, streaming, clone, destroy — through `page.evaluate`. System-Chrome mode clones the machine's already-downloaded Nano component into a locai-owned profile with copy-on-write (zero weights download, the live Chrome profile is never written; `LOCAI_CHROME` overrides the executable). CI mode downloads the component once into a cacheable profile when `LOCAI_NANO_ALLOW_DOWNLOAD=1`; `LOCAI_NANO_USER_DATA_DIR` pins the profile for `actions/cache`. Chromium builds cannot run Nano — only real Chrome works.
- `bench --backend=<name>` scores any registry backend through the seam; the first real-model run put Gemini Nano at 42.9% on the 7-scenario battery.
- `apple-fm` backend adapter for Apple Foundation Models on macOS 26+: a Swift stdio shim compiled from embedded source with `xcrun swiftc` on first use and cached in `node_modules/.cache/locai/`, honest availability reporting the framework's own reason — `deviceNotEligible`, `appleIntelligenceNotEnabled`, `modelNotReady` — and a `LOCAI_APPLE_FM_SHIM` override for prebuilt shims and tests. Single-shot prompting through the existing JSON repair path; streaming yields one chunk in v1.
- Initial fleet onboarding scaffolding.

### Changed

- Renamed the package from `@socketsecurity/gemini-nano` to `@socketsecurity/locai`; the `gnh` evaluation harness is now `bench` — the `./gnh` export and `pnpm run gnh` script are now `./bench` and `pnpm run bench`.
