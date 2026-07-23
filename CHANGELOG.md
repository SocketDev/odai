# Changelog

All notable changes to `@socketsecurity/locai` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Backend registry with `createLocaiModel` and `selectBackend`: backends `simulator`, `gemini-nano-headless`, `llama-server`, and `apple-fm` (declared, unavailable); selection precedence is explicit option, then `LOCAI_BACKEND` env var, then availability probe order.
- `llama-server` backend adapter for any OpenAI-compatible `/v1/chat/completions` endpoint: live `GET /health` availability probe, `LOCAI_LLAMA_URL` (default `http://127.0.0.1:8080`) and `LOCAI_LLAMA_MODEL` config, SSE streaming, and prefill emulation through the existing JSON repair path.
- Initial fleet onboarding scaffolding.

### Changed

- Renamed the package from `@socketsecurity/gemini-nano` to `@socketsecurity/locai`; the `gnh` evaluation harness is now `bench` — the `./gnh` export and `pnpm run gnh` script are now `./bench` and `pnpm run bench`.
