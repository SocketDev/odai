# Performance design

`@socketsecurity/odai` has separate browser, Node, CLI, and benchmark entry points.
The Node and CLI entries share emitted chunks. Their published entry paths stay unchanged.
The browser benchmark embeds a WebAssembly parser to verify generated JavaScript.
That parser accounts for most of the optional benchmark bundle.

## Distribution and cache storage

The regular entries use the declared `@sinclair/typebox` dependency and bundle the value helpers they import.
An experiment externalized those helpers. It reduced emitted bytes but increased measured module import time, so it was rejected.
Package measurements include shared chunks and distinguish installed dependencies from emitted files.

`decmpfs` provides two different mechanisms. Filesystem compression reduces allocated space while preserving file contents.
Its executable packer adds a native launcher that materializes an executable before running it.
That launcher does not fit importable JavaScript modules.

The copied-file measurements support investigating optional cache compression on supported filesystems.
They do not justify adding a native dependency to the normal browser or Node entry.
Gemma weights compressed much less than JavaScript or the Chrome Framework.
Compression cost and read performance need separate evaluation before making it a default cache operation.

The Chrome profile copier already requests filesystem clones with the platform copy command.
The cache exporter uses Node's copy operation, which discarded APFS compression in the measured runtime.
Preserving existing compression during export is a smaller change than introducing automatic compression.
Unsupported filesystems need the existing plain-file fallback.

## Streaming responses

`streamPrompt` merges each chunk as it arrives. It emits its early-field callback once, when the first configured field becomes parseable.
The callback can run while generation continues. Its output is provisional and does not replace final task validation.

Cancellation stops local waiting and requests stream cleanup. Reader locks are released on completion and failure.
The Chrome adapters forward cancellation to native generation and release operation state after completion.
The streaming helper does not destroy a session owned by its caller.

## Persistent conversations

Current task requests clone or recreate a session and dispose of that request session afterward.
This isolates tasks and prevents one task's result from becoming another task's input.
The [conversation API](../conversation/practices.md) provides an explicit session with retained messages.

The measured prototype keeps one Chrome session and sends only new turns.
Its comparison path recreates a session and replays the exact completed native history.
Chrome can retain native context in memory. Restoring after a process restart requires replaying stored messages.

<details>
<summary>Conversation guarantees and provider behavior</summary>

The conversation API provides the following behavior:

| Requirement        | Behavior                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Initial context    | Bind system instructions once. Do not resend task-level system messages on every turn.                                      |
| Ordering           | Serialize requests within one conversation. Keep separate conversations independent.                                        |
| Committed history  | Record completed, validated turns. Do not retain partial or failed output as successful history.                            |
| Recovery           | Discard an uncertain native session after cancellation or failure and restore committed history before continuing.          |
| Reset and disposal | Reject late results after reset or destruction. Make destruction safe to repeat.                                            |
| Context limits     | Bound retained history and report native overflow. A stored transcript can be larger than the native retained window.       |
| Persistence        | Let the caller choose storage. Export defensive copies of messages without automatically writing conversation text to disk. |

Provider capabilities must be explicit. Chrome clones retain context. The current Apple shim clone starts a fresh process.
The current llama adapter sends the supplied request messages without retaining them between calls.
The existence of a `clone()` method therefore does not establish persistent context support.

The current simulator does not retain native history. The conversation API supplies its committed transcript through the replay path.
Stateful test factories verify ordering, replay, isolation, and cleanup.
Such tests do not establish live model quality or inference speed.

Chrome adapters forward cancellation to native sessions and preserve native overflow status.
A failed constrained prompt propagates its error. The adapter does not resend a potentially committed turn.
The conversation disposes uncertain native state and restores committed messages before another attempt.

Chrome documents retained sessions, cloning, and transcript restoration in its [session management guide](https://developer.chrome.com/docs/ai/session-management).
Its [Prompt API guide](https://developer.chrome.com/docs/ai/prompt-api) describes initial prompts, context usage, and response prefixes.

</details>
