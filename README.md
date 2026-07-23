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
import { createGeminiNano } from '@socketsecurity/locai'

const nano = await createGeminiNano()
const response = await nano.prompt('Summarize this page in one sentence.')
console.log(response)
```

Run the `bench` evaluation harness against the built-in simulator:

```sh
pnpm run bench
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
