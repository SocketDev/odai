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
The Chrome bridge forwards cancellation to native operations and releases readers and operation controllers.

## Persistent conversation context

<details>
<summary>Native prototype measurements</summary>

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
The native prototype remains available as the direct Chrome baseline.
The [public conversation API](../conversation/practices.md) implements retained context, transcript replay, history bounds, recovery, and disposal.
Its benchmark measures the public API boundary, including lazy session creation. The native prototype timings above do not measure that API.

</details>

The public API passes deterministic native and replay tests and packed browser and Node consumer checks.
The restored live comparison ran five pairs through the public `odai/node` API. All 20 follow-up responses recalled the expected project code. Six of ten persistent responses and nine of ten fresh responses also followed the exact-output request. The remaining responses added ordinary prose or punctuation around the correct code.

| Public API follow-up measurement | Fresh replay | Persistent session |
| -------------------------------- | -----------: | -----------------: |
| Median complete response         |        868ms |              401ms |
| Median first output              |        781ms |              309ms |
| Median submitted text            |  4,413 chars |           28 chars |

There were ten follow-ups per mode. The [public API context report](../../../bench/results/conversation.json) includes the initialization turns and every response. Chrome 153 ran with Gemma 4 on an Apple M3 Max. The persistent path reduced median completion time by 54% and submitted 99% less text after initialization in this fixture.

The new `odai setup` command prepared the persistent profile, allowed the component download, verified the Gemma 4 response, and closed Chrome in 7.0s after the model was present. Repository provisioning can invoke the fleet Rust target sweep when free space is below 22GiB. Package consumers receive the same measurement and retry behavior through a host-owned `reclaimStorage` callback, so the library never guesses which application data it may delete.

The [API footprint report](../../../bench/results/footprint-conversation.json) measures the added conversation implementation and lockstep corrections.
It retains shared package chunks and the existing runtime dependency set.

## Full and sparse lockstep evaluation

Generated patches now include available context and correct final-newline markers.
Integration tests use default Git application checks with full files and partial evidence.
The evaluator parses changed files and checks the exported value and an active regression assertion that uses it.
Equivalent formatting and import aliases can pass. Invalid code, inactive assertions, and incorrect values fail.

The [live comparison](../../../bench/results/lockstep.json) kept fixture inputs and prompt examples unchanged.
The current result uses normal request context across three pairs and both materializations.

| Materialization | Passed | Attempts | Mean response time |
| --------------- | -----: | -------: | -----------------: |
| Full            |    2/3 |        7 |            5,054ms |
| Sparse          |    2/3 |        5 |            3,735ms |

Preloading remains rejected because the earlier run caused more retries and reduced fixture success.
The restored normal path passed two of three sparse cases and two of three full cases.
The failures omitted a required regression test or lost the target citation after corrective retries.
The model identified itself as Gemma 4. That identification is recorded as a model response, not an independent attestation.

<details>
<summary>Validation changes and the blocked live rerun</summary>

An earlier two-pair exploratory run passed all four normal-context cases. The repeated run demonstrates why that was insufficient evidence of reliability.
These fixtures test a small value change. They do not establish readiness for unfamiliar upstream ports.
Deterministic simulator and unit tests verify the harness. They do not increase the live model's score.

The task now requires target-revision citations and accepts caller-supplied semantic validation.
It allows at most three total attempts and sends the actual validation diagnostic after a rejected proposal.
The benchmark applies changes in memory and reuses its existing parser oracle for this feedback.
The six fixture cases and their acceptance criteria remain unchanged. Every attempt and response is recorded.

An earlier six-case rerun timed out because only 6.4GiB was free and Chrome had removed the cached Gemma weights.
The scripted provisioning path reclaimed build storage, restored the model, and completed the current six-case run.
Chrome startup checks storage before launch. It requires 10GiB for an existing model or 22GiB while provisioning.

</details>

## Verification

The executable coverage run measured 99.39%, and the direct type pass measured 99.80%.
The full suite passed 1,579 tests, with two optional conformance cases skipped.
It completed in 7.52s after two timeout tests stopped spending 5s each on an unrelated identity probe.
The repository enforces a 99% executable line coverage floor.
Build, declarations, packed browser/Node consumer checks, and full lint passed.
The public API has 68 focused behavior tests. Controlled Chrome tests cover native cancellation, late completion, overflow, and the storage guard.
Mocked providers cover recovery and cleanup failures. This coverage pass added no exclusions.
These checks establish library behavior. A live model score remains separate from deterministic verification.
