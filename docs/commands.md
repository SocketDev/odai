# Command Reference

The `odai` executable accepts task commands, backend operations, and a loopback server command. Task names and descriptions come from [`src/cli/commands.mts`](../src/cli/commands.mts). The CLI also accepts `--input`, `--timeout`, `--backend`, `--raw`, `--instruction`, and command-specific options parsed in [`src/cli/args.mts`](../src/cli/args.mts).

## Task commands

| Command         | Purpose                                                         | Input                                  |
| --------------- | --------------------------------------------------------------- | -------------------------------------- |
| `classify-deps` | Classify a narrowed dependency change as routine or unexpected. | Dependency diff JSON or text.          |
| `commit-msg`    | Suggest a Conventional Commit subject.                          | Diff text.                             |
| `dedupe`        | Identify package versions that can be consolidated.             | JSON on stdin.                         |
| `hoist`         | Assess a cross-major dependency hoist.                          | Changelog evidence as JSON.            |
| `lockfile`      | Explain a lockfile excerpt.                                     | Lockfile text or JSON input.           |
| `lockstep`      | Analyze full or sparse upstream lockstep evidence.              | JSON on stdin.                         |
| `patch`         | Generate a unified diff for a file.                             | File plus `--instruction`.             |
| `pricing`       | Extract per-token model prices from a pricing page.             | Page content as JSON.                  |
| `release-bump`  | Classify a release from commits.                                | Commit evidence as JSON.               |
| `security-fix`  | Select a safe dependency update for an advisory.                | Advisory and package evidence as JSON. |
| `summarize`     | Return a summary and key points.                                | Text.                                  |
| `triage`        | Explain aggregate security findings.                            | Findings JSON or text.                 |
| `weekly-update` | Plan soak-gated dependency updates.                             | JSON on stdin.                         |

`src/cli/commands.mts` marks `lockstep` and `patch` as heavy tasks. The command dispatch and each task's accepted shape are in [`src/cli/dispatch.mts`](../src/cli/dispatch.mts).

## Backend and server commands

| Command    | Behavior                                            | Options                                      |
| ---------- | --------------------------------------------------- | -------------------------------------------- |
| `backends` | Print availability details for registered backends. | None.                                        |
| `serve`    | Start the loopback compatibility server.            | `--port`, `--backend`.                       |
| `setup`    | Prepare the Chrome built-in model.                  | Setup options in the CLI parser.             |
| `batch`    | Run JSONL tasks over one backend launch.            | `--input`, `--timeout`; `--raw` is rejected. |

The server listens on `127.0.0.1`; `--port 0` requests an available port. See the [service reference](./service.md) for routes and supported request behavior.

## Input, output, and exit codes

Task input comes from stdin or `--input`. Successful results print as JSON unless `--raw` is supported by the command. Diagnostics go to stderr. Batch output contains one JSON line per manifest entry; task failures are represented in those lines.

| Exit code | Meaning                                                         |
| --------- | --------------------------------------------------------------- |
| `0`       | Command ran successfully.                                       |
| `1`       | Model or task failure, invalid reply, timeout, or engine error. |
| `2`       | Invalid command usage or malformed batch manifest.              |
| `69`      | No backend is available.                                        |

The timeout defaults to 120000ms. Set `--timeout <ms>` or `ODAI_TIMEOUT_MS` to choose another task budget. Batch timeout applies to each task.

## Examples

```sh
git diff | odai commit-msg
odai summarize --input README.md
odai patch --input src/greet.js --instruction 'Use a template literal.'
printf '%s\n' '{"id":"review","task":"commit-msg","input":"diff content"}' | odai batch
odai backends
odai serve --port 0
```
