# Local inference shim

A loopback HTTP server that speaks both wire formats `llama-server` speaks -
the Anthropic Messages API and the OpenAI chat-completions API - over any odai
registry backend. An Anthropic-speaking agent (Claude Code via
`ANTHROPIC_BASE_URL`) and an OpenAI-speaking one both run against local
inference with no API key, on the same port.

odai is a `llama-server` client already, through the `llama-server` backend.
Serving the same routes closes the loop: odai can talk to it, and present as
it to anything else.

## Run it

```sh
node --experimental-strip-types src/shim/serve.mts --port 8402 --backend llama-server
```

Backend selection follows the registry precedence: `--backend` wins, then
`ODAI_BACKEND`, then the availability probe. Point a client at the shim:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_API_KEY=anything \
  claude --print --output-format stream-json "your prompt"
```

```sh
OPENAI_BASE_URL=http://127.0.0.1:8402/v1 OPENAI_API_KEY=anything
```

Any non-empty key satisfies client-side checks; the shim ignores auth
entirely. The server binds loopback only and refuses a routable interface,
mirroring the llama-server doctrine.

## Routes

| Route                                    | Notes                                                   |
| ---------------------------------------- | ------------------------------------------------------- |
| `POST /v1/messages`                      | Anthropic Messages, streaming and not                   |
| `POST /v1/messages/count_tokens`         | chars-over-four estimate                                |
| `POST /v1/chat/completions`              | OpenAI chat completions, streaming and not              |
| `POST /v1/chat/completions/input_tokens` | same estimate, `response.input_tokens` shape            |
| `GET /v1/models`                         | one entry, id is the selected backend, `owned_by: odai` |
| `GET /health`, `GET /v1/health`          | `{"status": "ok"}`                                      |

Out of scope, because odai has no tokenizer, no embeddings, and no slots to
report: `/completion`, `/tokenize`, `/detokenize`, `/embedding`, `/reranking`,
`/infill`, `/props`, `/slots`, `/metrics`, `/lora-adapters`, `/v1/responses`,
and llama-server's multi-model `/models` family.

## What it implements

- Streaming in each format's own shape. Anthropic gets the full SSE sequence
  (`message_start`, `content_block_start`, `content_block_delta` with
  `text_delta` and `input_json_delta`, `content_block_stop`, `message_delta`
  with `stop_reason` plus usage, `message_stop`); OpenAI gets
  `chat.completion.chunk` frames ending in `data: [DONE]`, with a usage-only
  frame when `stream_options.include_usage` asks for one.
- System prompts as a string or a block array, plus OpenAI's `developer` role;
  `cache_control` markers are accepted and ignored.
- Tool use over a text-only backend interface: tool definitions become a
  prompt-engineered one-line JSON protocol, replies are scanned for a tool
  call through the shared JSON hardening - code fences, fullwidth
  punctuation, balanced-object extraction, plus an unbalanced-close repair
  for the one-brace-short calls observed live from Qwen2.5-Coder-7B - and a
  detected call comes back as a `tool_use` block or a `tool_calls` entry with
  `finish_reason: "tool_calls"`. Tool results round-trip back as tagged text
  from either an Anthropic `tool_result` block or an OpenAI `tool` turn.
- `stop_sequences` and `stop` with truncation, and each format's own error
  envelope: `{"type": "error", ...}` for Anthropic, `{"error": {"code", ...}}`
  for OpenAI.
- A model-less OpenAI request, the way llama-server tolerates it: a single
  model has nothing to route, so an absent `model` takes the shim's own id.

## What real agent runs would still need

- True incremental streaming. The backend reply is fully buffered before the
  replay because tool detection needs the whole reply, so time to first token
  equals full generation time.
- Prompt caching. Every turn re-prefills the entire conversation; with Claude
  Code's default ~30k-token surface that is 60-70 s per call on a 7B.
- Parallel tool calls: only the first JSON object in a reply is detected.
- Enforced `max_tokens`, request-supplied `temperature` (decoding is pinned
  greedy), real tokenizer counts, images, thinking blocks, `tool_choice`,
  request cancellation.

## Measured verdict with Claude Code 2.1.219

Real Claude Code completed turns against Qwen2.5-Coder-7B-Instruct through
the shim. With the default surface - 25 tools, ~30k input tokens - the 7B
ignored the tool protocol and answered in prose, so no tool was ever called.
With the tool list cut to Bash alone, ~10k input tokens, the full agentic
loop worked end to end: `tool_use` emitted, command executed, result consumed,
correct final answer. The shim is not the bottleneck; model capability at
full agent scale is.
