# Anthropic Messages shim

A loopback HTTP server that speaks the Anthropic Messages API over any odai
registry backend, so an Anthropic-speaking agent — Claude Code via
`ANTHROPIC_BASE_URL` — runs against local inference with no API key.

## Run it

```sh
node --experimental-strip-types src/shim/serve.mts --port 8402 --backend llama-server
```

Backend selection follows the registry precedence: `--backend` wins, then
`ODAI_BACKEND`, then the availability probe. Point the client at the shim:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_API_KEY=anything \
  claude --print --output-format stream-json "your prompt"
```

Any non-empty key satisfies client-side checks; the shim ignores auth
entirely. The server binds loopback only and refuses a routable interface,
mirroring the llama-server doctrine.

## What it implements

- `POST /v1/messages`, streaming and non-streaming. Streaming emits the full
  SSE sequence: `message_start`, `content_block_start`, `content_block_delta`
  with `text_delta` and `input_json_delta`, `content_block_stop`,
  `message_delta` with `stop_reason` plus usage, `message_stop`.
- System prompts as a string or a block array; `cache_control` markers are
  accepted and ignored.
- Tool use over the text-only backend seam: tool definitions become a
  prompt-engineered one-line JSON protocol, replies are scanned for a tool
  call through the shared JSON hardening — code fences, fullwidth
  punctuation, balanced-object extraction, plus an unbalanced-close repair
  for the one-brace-short calls observed live from Qwen2.5-Coder-7B — and a
  detected call is emitted as a `tool_use` block with a fresh id.
  `tool_result` blocks round-trip back as tagged text.
- `stop_sequences` with truncation, `POST /v1/messages/count_tokens` with a
  chars-over-four estimate, `GET /health`, Anthropic-shaped error JSON.

## What real agent runs would still need

- True incremental streaming. The backend reply is fully buffered before the
  SSE replay because tool detection needs the whole reply, so time to first
  token equals full generation time.
- Prompt caching. Every turn re-prefills the entire conversation; with Claude
  Code's default ~30k-token surface that is 60-70 s per call on a 7B.
- Parallel tool calls: only the first JSON object in a reply is detected.
- Enforced `max_tokens`, request-supplied `temperature`, real tokenizer
  counts, images, thinking blocks, `tool_choice`, request cancellation.

## Measured verdict with Claude Code 2.1.219

Real Claude Code completed turns against Qwen2.5-Coder-7B-Instruct through
the shim. With the default surface — 25 tools, ~30k input tokens — the 7B
ignored the tool protocol and answered in prose, so no tool was ever called.
With the tool list cut to Bash alone, ~10k input tokens, the full agentic
loop worked end to end: `tool_use` emitted, command executed, result consumed,
correct final answer. The shim is not the bottleneck; model capability at
full agent scale is.
