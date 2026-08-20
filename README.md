# @socketsecurity/odai

<div align="center">
  <img src="https://raw.githubusercontent.com/SocketDev/odai/HEAD/assets/repo/odai-combomark.svg" width="240" alt="odai - the odai badge: the odai wordmark, on disk AI, socket labs, and stacked storage layers inside the violet shield">
</div>

<a href="https://badge.socket.dev/npm/package/@socketsecurity/odai"><img src="https://badge.socket.dev/npm/package/@socketsecurity/odai" alt="Socket Badge" height="20"></a>
<img src="https://raw.githubusercontent.com/SocketDev/odai/HEAD/assets/repo/coverage.svg" width="97" height="20" alt="Coverage" />

[![Follow @SocketSecurity](https://raw.githubusercontent.com/SocketDev/odai/HEAD/assets/fleet/badge-follow-x.svg)](https://twitter.com/SocketSecurity)
[![Follow @socket.dev on Bluesky](https://raw.githubusercontent.com/SocketDev/odai/HEAD/assets/fleet/badge-follow-bluesky.svg)](https://bsky.app/profile/socket.dev)

odai - pronounced like the trickster; it lives in your machine and does your chores.

odai is local-only - the primary backend is Chrome's built-in AI (the Prompt
API, stable since Chrome 148) via installed Google Chrome on every platform;
llama-server (loopback) is the local fallback; Apple FM and Phi Silica
(Copilot+) are opportunistic per-OS extras. No cloud, no remote endpoints, no
keys.

The Prompt API is model-agnostic by design, so odai names its backend for the
interface rather than the model. The on-device model is Gemini Nano today;
Gemma 4 is [the base for the next Gemini Nano](https://android-developers.googleblog.com/2026/04/gemma-4-new-standard-for-local-agentic-intelligence.html)
and is already testable in Chrome Canary behind the "Gemma 4 for Built-in AI"
flag.

`@socketsecurity/odai` is a local, on-device AI library for browser and Node.
It wraps the browser's built-in AI Prompt API behind a type-safe,
backend-agnostic seam, hardens small-model JSON output, and ships `bench` - an
evaluation harness that scores any backend on real Socket workloads. It exists
so Socket code can feature-detect, prompt, and parse on-device model responses
without scattering DOM-specific checks across consumers.

## Install

```sh
pnpm install @socketsecurity/odai
```

## Usage

```js
import { createOdaiModel } from '@socketsecurity/odai'

const model = await createOdaiModel()
const { raw } = await model.promptStreaming(
  'Summarize this page in one sentence.',
)
console.log(raw)
```

`createOdaiModel` picks a backend by precedence: the explicit `backend`
option, then the `ODAI_BACKEND` env var, then the availability probe order -
`chrome-builtin`, `llama-server`, `apple-fm`, `windows-phi-silica`,
`simulator`.

### CLI

The package ships a `odai` bin for single-shot, keyless AI steps in scripts
and CI. Input arrives on stdin or `--input`; the parsed result prints as one
JSON line on stdout, diagnostics go to stderr.

<details>
<summary>Command examples, the exit-code contract, and batch mode</summary>

```sh
git diff | odai commit-msg
printf 'Critical: 2\nHigh: 5\n' | odai triage
odai summarize --input README.md
odai patch --input src/greet.js --instruction "use a template literal"
odai classify-deps --input narrowed-dep-diff.json
odai backends
printf '%s\n' '{"id":"a","task":"summarize","input":"release notes..."}' '{"id":"b","task":"commit-msg","input":"diff --git..."}' | odai batch
```

Every prompt runs under a hard budget - `--timeout <ms>` or the
`ODAI_TIMEOUT_MS` env var, default 120000 - so a wedged engine can never hang
a job. Exit codes are the CI contract:

| code | meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | success - parsed JSON on stdout                                 |
| 1    | model or task failure - invalid reply, timeout, or engine error |
| 2    | usage error                                                     |
| 69   | no backend available - treat as a clean skip in CI              |

When nothing is provisioned the CLI prints the exact provisioning steps for
each backend and exits 69; `odai backends` prints per-backend availability
JSON with the reason for every unavailable engine.

`odai batch` reads a JSONL manifest (stdin or `--input`), runs every task over a single backend launch, and prints one JSON line per entry in manifest order - `{"id","ok":true,"value":…}` or `{"id","ok":false,"error":…}`. It exits 0 when the batch ran even if every task failed (failures are in-band lines), 2 on a malformed manifest (checked in full before any task runs), and 69 when no backend is available. `--timeout` is the per-task budget; `--raw` is not accepted.

</details>

### Serve

`odai serve` turns any backend into a loopback HTTP server speaking both wire
formats `llama-server` does, on one port: the Anthropic Messages API
(`POST /v1/messages`, `/v1/messages/count_tokens`) and the OpenAI
chat-completions API (`POST /v1/chat/completions`,
`/v1/chat/completions/input_tokens`, `GET /v1/models`), plus `/health`. odai
already talks to `llama-server` as a client, so serving the same routes lets
anything pointed at a local OpenAI base URL treat odai as the server it would
otherwise run. Tool calling works on both sides and is emulated for plain-text
engines: the shim teaches the model a one-line JSON tool-call protocol in the
system prompt and reads the reply back into `tool_use` blocks or `tool_calls`,
with the same JSON repair hardening the tasks use.

```sh
odai serve                  # 127.0.0.1:8402, backend from the registry probe
odai serve --port 0         # let the OS pick a free port
odai serve --backend llama-server
```

<details>
<summary><b>Pointing a client at it</b> - the two base-URL forms, and the one request field the shim ignores</summary>

Point any Anthropic-speaking client at the printed URL with
`ANTHROPIC_BASE_URL` and any non-empty `ANTHROPIC_API_KEY` (loopback only, no
auth). For example, [communique](https://github.com/jdx/communique) runs its
release-notes agent loop against local inference with no code changes:

```sh
communique --provider anthropic --model local \
  --base-url http://127.0.0.1:8402
```

An OpenAI-speaking client points at the same port's `/v1` prefix, the way it
would at `llama-server`:

```sh
OPENAI_BASE_URL=http://127.0.0.1:8402/v1 OPENAI_API_KEY=anything
```

Known limitation: the shim ignores `max_tokens` in the request - odai's
session interface has no output-token budget - and never emits a `max_tokens`
stop reason, so a reply cut short by the engine itself (for example
llama-server's own `n_predict` default) arrives as `end_turn`.

</details>

### Bench

Run the `bench` evaluation harness against the built-in simulator, or score a
real backend with `--backend`:

```sh
pnpm run bench
pnpm run bench --backend=chrome-builtin
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
