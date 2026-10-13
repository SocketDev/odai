# Service Reference

`odai serve` starts a loopback server that adapts an available local model to Anthropic Messages and OpenAI Chat Completions clients. The route handlers and request parsing are implemented in [`src/cli/serve.mts`](../src/cli/serve.mts) and [`src/shim/server.mts`](../src/shim/server.mts).

## Start the service

```sh
odai serve
odai serve --port 0
odai serve --backend llama-server
```

The default bind address is `127.0.0.1`, and the default port is `8402`. Port `0` lets the operating system select an available port. Backend selection follows the explicit `--backend` value when provided; otherwise the registry chooses from its configured probe order.

## Routes

| Method | Path                                | Purpose                                                                         |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------- |
| `GET`  | `/health`                           | Report service health.                                                          |
| `GET`  | `/v1/models`                        | List the model identity exposed by the OpenAI-compatible API.                   |
| `POST` | `/v1/chat/completions`              | Accept OpenAI Chat Completions requests.                                        |
| `POST` | `/v1/chat/completions/input_tokens` | Estimate input token information using the server's supported request handling. |
| `POST` | `/v1/messages`                      | Accept Anthropic Messages requests.                                             |
| `POST` | `/v1/messages/count_tokens`         | Count message input tokens using the server's supported request handling.       |

The exact body fields, response shapes, and status codes are defined in the route handlers in `src/shim/server.mts`. Streaming responses adapt the backend stream to the protocol event format. Plain-text backends emulate tool calls through the control-token protocol described in the README.

## Authentication and limits

The server accepts loopback clients without authentication. Point Anthropic clients at the printed base URL with `ANTHROPIC_BASE_URL` and a non-empty `ANTHROPIC_API_KEY`. Point OpenAI clients at the printed base URL followed by `/v1`; a non-empty API key value is accepted by compatible clients.

The adapter ignores `max_tokens` because the model session interface has no output-token budget. It does not emit a `max_tokens` stop reason. Backend-level output limits may still end a reply.

## Related references

- See the [command reference](./commands.md) for CLI task and server options.
- See the [API reference](./api.md) for exported backend and model interfaces.
- See [keyless CI guidance](./keyless-ci-ai.md) for backend provisioning constraints.
