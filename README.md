# @socketsecurity/locai

<a href="https://badge.socket.dev/npm/package/@socketsecurity/locai"><img src="https://badge.socket.dev/npm/package/@socketsecurity/locai" alt="Socket Badge" height="20"></a>
<img src="assets/repo/badges/coverage.svg" width="97" height="20" alt="Coverage" />

[![Follow @SocketSecurity](assets/fleet/badge-follow-x.svg)](https://twitter.com/SocketSecurity)
[![Follow @socket.dev on Bluesky](assets/fleet/badge-follow-bluesky.svg)](https://bsky.app/profile/socket.dev)

locai — pronounced like the trickster; it lives in your machine and does your chores.

## Why this repo exists

locai is local-only — the primary backend is Gemini Nano via installed Google
Chrome on every platform; llama-server (loopback) is the local fallback; Apple
FM and Phi Silica (Copilot+) are opportunistic per-OS extras. No cloud, no
remote endpoints, no keys.

`@socketsecurity/locai` is a local, on-device AI library for browser and Node.
It wraps the browser's built-in Gemini Nano Prompt API behind a type-safe,
backend-agnostic seam, hardens small-model JSON output, and ships `bench` — an
evaluation harness that scores any backend on real Socket workloads. It exists
so Socket code can feature-detect, prompt, and parse on-device model responses
without scattering DOM-specific checks across consumers.

## Install

```sh
pnpm install @socketsecurity/locai
```

## Usage

```js
import { createLocaiModel } from '@socketsecurity/locai'

const model = await createLocaiModel()
const { raw } = await model.promptStreaming(
  'Summarize this page in one sentence.',
)
console.log(raw)
```

`createLocaiModel` picks a backend by precedence: the explicit `backend`
option, then the `LOCAI_BACKEND` env var, then the availability probe order —
`gemini-nano-headless`, `llama-server`, `apple-fm`, `windows-phi-silica`,
`simulator`.

### CLI

The package ships a `locai` bin for single-shot, keyless AI steps in scripts
and CI. Input arrives on stdin or `--input`; the parsed result prints as one
JSON line on stdout, diagnostics go to stderr.

```sh
git diff | locai commit-msg
printf 'Critical: 2\nHigh: 5\n' | locai triage
locai summarize --input README.md
locai patch --input src/greet.js --instruction "use a template literal"
locai classify-deps --input narrowed-dep-diff.json
locai backends
```

Every prompt runs under a hard budget — `--timeout <ms>` or the
`LOCAI_TIMEOUT_MS` env var, default 120000 — so a wedged engine can never hang
a job. Exit codes are the CI contract:

| code | meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | success — parsed JSON on stdout                                 |
| 1    | model or task failure — invalid reply, timeout, or engine error |
| 2    | usage error                                                     |
| 69   | no backend available — treat as a clean skip in CI              |

When nothing is provisioned the CLI prints the exact provisioning steps for
each backend and exits 69; `locai backends` prints per-backend availability
JSON with the reason for every unavailable engine.

### Bench

Run the `bench` evaluation harness against the built-in simulator, or score a
real backend with `--backend`:

```sh
pnpm run bench
pnpm run bench --backend=gemini-nano-headless
```

## Development

<details>
<summary>Contributor commands</summary>

```sh
pnpm install
pnpm run check
pnpm run test
```

</details>

## License

MIT

<br/>
<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/fleet/socket-lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/fleet/socket-lockup-light.svg">
    <img width="420" height="120" alt="Socket" src="assets/fleet/socket-lockup-light.svg">
  </picture>
</div>
