# @socketsecurity/gemini-nano

<a href="https://badge.socket.dev/npm/package/@socketsecurity/gemini-nano"><img src="https://badge.socket.dev/npm/package/@socketsecurity/gemini-nano" alt="Socket Badge" height="20"></a>
<img src="assets/repo/badges/coverage.svg" width="97" height="20" alt="Coverage" />

[![Follow @SocketSecurity](assets/fleet/badge-follow-x.svg)](https://twitter.com/SocketSecurity)
[![Follow @socket.dev on Bluesky](assets/fleet/badge-follow-bluesky.svg)](https://bsky.app/profile/socket.dev)

On-device Gemini Nano Prompt API library for browser and Node.

## Why this repo exists

`@socketsecurity/gemini-nano` provides a small, type-safe wrapper around the
browser's built-in Gemini Nano Prompt API and a Node-compatible shim for
testing and tooling. It exists so Socket code can feature-detect, prompt, and
parse Nano responses without scattering DOM-specific checks across consumers.

## Install

```sh
pnpm install @socketsecurity/gemini-nano
```

## Usage

```js
import { createGeminiNano } from '@socketsecurity/gemini-nano'

const nano = await createGeminiNano()
const response = await nano.prompt('Summarize this page in one sentence.')
console.log(response)
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
