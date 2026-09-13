# Performance journal

## Shared package chunks

The Node and CLI builds now share their generated chunks. Published entry paths remain unchanged.
The change removes duplicate distributed code. Individual imports still load comparable amounts of code.

| Emitted JavaScript |  Before |  After | Reduction |
| ------------------ | ------: | -----: | --------: |
| Raw                | 10.37MB | 8.93MB |     13.8% |
| gzip               |  2.14MB | 1.85MB |     13.6% |
| Brotli             |  1.29MB | 1.05MB |     18.2% |

These totals include every emitted JavaScript file, including the optional browser benchmark.
Compressed totals sum files compressed separately. They do not represent an npm tarball or installed dependencies.
The [baseline](../../../bench/results/footprint-before.json) and [current report](../../../bench/results/footprint.json) include static and dynamic import graphs.
The baseline uses `fdec47e`. The current report also includes the streaming and lockstep corrections from this pass.

An experiment externalized `@sinclair/typebox/value`. It saved more emitted bytes but increased sampled import cost.
That change was rejected. Its [size report](../../../bench/results/footprint-external-value.json) and [import samples](../../../bench/results/imports-external-value.json) remain available.

The retained build's [import samples](../../../bench/results/imports.json) use seven interleaved pairs of fresh Node processes per entry.
They include runtime dependencies and measure memory after explicit garbage collection.
Other local work affected timings. These samples do not establish a startup speed improvement.
The Node entry's retained heap rose by approximately 90KB. The browser entry's retained heap rose by approximately 18KB.

## Parser payload

The optional browser benchmark embeds about 6.3MB of parser code and base64 data in a roughly 6.7MB entry.
The parser is outside the normal browser entry.
The [encoding comparison](../../../bench/results/parser-encoding.json) measures the same installed WebAssembly bytes in two representations.

| Parser representation |    Raw |   gzip | Brotli |
| --------------------- | -----: | -----: | -----: |
| Binary WebAssembly    | 4.72MB |  777KB |  400KB |
| Base64                | 6.29MB | 1.31MB |  602KB |

Serving a separate binary asset could save about 530KB gzip or 202KB Brotli before loader changes.
This remains a design option. The current synchronous parser initialization needs an explicit asynchronous preparation step before that change can ship.
The byte comparison does not measure download, parser startup, or browser memory.

## Filesystem compression

Copied-file measurements support optional cache compression on APFS. They do not establish an inference improvement.

| Copied file              | Allocated space saved | Compression time |
| ------------------------ | --------------------: | ---------------: |
| Gemma weights            |  10.53%, about 249MiB |           51.44s |
| Classifier weights       |   17.97%, about 22MiB |            1.14s |
| Chrome Framework         |  53.26%, about 266MiB |            7.36s |
| Three JavaScript entries |       69.72% combined |       6–8ms each |

Every complete output matched its input SHA256. Original files were left unchanged.
Large-file trials used Node 24.10.0. The JavaScript and copy tests also ran with Node 26.8.1.
The [storage report](../../../bench/results/storage.json) records the native addon hash, source revisions, machine, and limitations.
Its JavaScript input came from the earlier `8999883` checkout, separate from the package comparison above.

The available native addon predates the inspected `decmpfs` source. These measurements describe that binary.
Header probes found LZVN for a small stream and LZFSE for a stream above 64MiB.
The full-file outputs were deleted before their codec headers were recorded, so their codec is not asserted here.

On the measured Node runtimes, `COPYFILE_FICLONE` discarded APFS compression. `cp -c` preserved it.
Cache export can benefit from preserving compression already present in a file.
Automatic compression remains optional design work. It adds a native dependency and a potentially expensive cache preparation step.
The native executable packer does not fit importable JavaScript files.

## Early streaming output

The streaming helper previously collected every chunk before invoking its early-field callback.
It now processes each chunk and invokes the callback once when a configured field becomes parseable.
It also releases reader locks and returns promptly after cancellation.

Controlled tests hold a stream open and verify that the callback fires before completion.
They also cover cancellation between a promise settling and its result being consumed.
This establishes earlier delivery at the library boundary. It does not change model generation speed.
The Chrome bridge still needs native cancellation forwarding to stop generation after local waiting ends.

## Persistent conversation context

The native prototype retained context across three-turn conversations and passed all 30 recall checks.
Each of five pairs compared retained state with a fresh session replaying the same completed native messages.
The fixture supplied a project code in the first turn and requested it in both follow-ups.

| Follow-up measurement                | Fresh replay | Persistent session |
| ------------------------------------ | -----------: | -----------------: |
| Median complete response             |      1,471ms |              491ms |
| Median first output, including setup |      1,371ms |              402ms |
| Median session setup                 |      1,055ms |                0ms |
| Median first chunk after prompting   |        308ms |              402ms |

There were ten follow-ups per mode. Initialization turns are retained in the data but excluded from this table.
The [context report](../../../bench/results/context.json) records each result, submitted text size, and native context usage.
Chrome 153 ran with Gemma 4 requested. The native window was 9,216 tokens, with roughly 1,024 tokens used by this fixture.
The machine was an Apple M3 Max on AC power. Other local work was active, so treat this as an exploratory comparison.

Session setup accounts for the supported end-to-end saving. Generation alone was not consistently faster.
The prototype does not add a public persistent conversation API.
The [design](design.md#persistent-conversations) lists the required provider capabilities, history limits, recovery, and disposal rules.

## Full and sparse lockstep evaluation

Generated patches now include available context and correct final-newline markers.
Integration tests use default Git application checks with full files and partial evidence.
The evaluator parses changed files and checks the exported value and an active regression assertion that uses it.
Equivalent formatting and import aliases can pass. Invalid code, inactive assertions, and incorrect values fail.

The [live comparison](../../../bench/results/lockstep.json) kept fixture inputs and prompt examples unchanged.
It alternated normal request context with a preloaded template, using three pairs and both materializations.

| Context mode           | Passed | Attempts | Mean response time |
| ---------------------- | -----: | -------: | -----------------: |
| Normal request context |    4/6 |        7 |            2,974ms |
| Preloaded template     |    3/6 |        9 |            5,876ms |

Preloading was rejected. It caused more retries and reduced fixture success in this sample.
The normal path passed all three sparse cases and one of three full cases.
Failures included comparing local code with the base revision, omitting a regression test, and generating invalid JavaScript.
The model identified itself as Gemma 4. That identification is recorded as a model response, not an independent attestation.

An earlier two-pair exploratory run passed all four normal-context cases. The repeated run demonstrates why that was insufficient evidence of reliability.
These fixtures test a small value change. They do not establish readiness for unfamiliar upstream ports.
Deterministic simulator and unit tests verify the harness. They do not increase the live model's score.

## Verification

The full suite passed 1,408 tests, with two existing external-conformance tests skipped.
Build, declarations, packed browser/Node consumer checks, and focused lint passed.
The full suite took 12.89s while other local work was active. This is a validation result, not evidence of a faster test suite.
