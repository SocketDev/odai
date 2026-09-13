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

The direct Chrome comparison retained the project code in every follow-up across five three-turn conversation pairs. Exact output passed 10/10 persistent follow-ups and 9/10 fresh follow-ups.
Each of five pairs compared retained state with a fresh session replaying the same completed native messages.
The fixture supplied a project code in the first turn and requested it in both follow-ups.

| Follow-up measurement                | Fresh replay | Persistent session |
| ------------------------------------ | -----------: | -----------------: |
| Median complete response             |      1,052ms |              439ms |
| Median first output, including setup |        941ms |              347ms |
| Median session setup                 |        645ms |                0ms |
| Median first chunk after prompting   |        308ms |              347ms |

There were ten follow-ups per mode. Initialization turns are retained in the data but excluded from this table.
The [context report](../../../bench/results/context.json) records each result, submitted text size, and native context usage.
Chrome 153 ran with Gemma 4 requested. The native window was 9,216 tokens, with roughly 1,024 tokens used by this fixture.
The machine was an Apple M3 Max. Other local work was active, so treat this as an exploratory comparison.

Session setup accounts for the supported end-to-end saving. Generation alone was not consistently faster.
The native prototype remains available as the direct Chrome baseline.
The [public conversation API](../conversation/practices.md) implements retained context, transcript replay, history bounds, recovery, and disposal.
Its benchmark measures the public API boundary, including lazy session creation. The native prototype timings above do not measure that API.

</details>

The public API passes deterministic native and replay tests and packed browser and Node consumer checks.
The restored live comparison ran five pairs through the public `odai/node` API. All 20 follow-up responses recalled the expected project code. Eight of ten persistent responses and all ten fresh responses also followed the exact-output request. The remaining responses added ordinary prose or punctuation around the correct code.

| Public API follow-up measurement | Fresh replay | Persistent session |
| -------------------------------- | -----------: | -----------------: |
| Median complete response         |        919ms |              423ms |
| Median first output              |        850ms |              328ms |
| Median submitted text            |  4,415 chars |           28 chars |

There were ten follow-ups per mode. The [public API context report](../../../bench/results/conversation.json) includes the initialization turns and every response. Chrome 153 ran with Gemma 4 on an Apple M3 Max. The persistent path reduced median completion time by 54% and submitted 99% less text after initialization in this fixture.

The new `odai setup` command prepared the persistent profile, allowed the component download, verified the Gemma 4 response, and closed Chrome in 7.0s after the model was present. Repository provisioning can invoke the fleet Rust target sweep when free space is below 22GiB. Package consumers receive the same measurement and retry behavior through a host-owned `reclaimStorage` callback, so the library never guesses which application data it may delete.

The [API footprint report](../../../bench/results/footprint-conversation.json) measures the added conversation implementation and lockstep corrections.
It retains shared package chunks and the existing runtime dependency set.

## Full and sparse lockstep evaluation

Generated patches now include available context and correct final-newline markers.
Integration tests use default Git application checks with full files and partial evidence.
The evaluator parses changed files and checks the exported value and an active regression assertion that uses it.
Equivalent formatting and import aliases can pass. Invalid code, inactive assertions, and incorrect values fail.

The [live comparison](../../../bench/results/lockstep.json) uses the original six cases and acceptance criteria.
The prompt now contains one shared example instead of separate full and sparse copies of the same contract.
This reduces first-attempt input from 7,316 to 5,840 characters for full materialization and from 7,332 to 5,856 for sparse materialization.
The reduction is about 20%. The backend reported Gemma 4.

| Materialization | Passed | Attempts | Mean response time |
| --------------- | -----: | -------: | -----------------: |
| Full            |    3/3 |        3 |            2,194ms |
| Sparse          |    3/3 |        3 |            2,197ms |

The [confirmation run](../../../bench/results/lockstep-confirmation.json) also passed 6/6 cases with a 30s per-operation limit. It reported Gemma 4 and kept the same fixture assertions.
An earlier confirmation stopped after four passes because the provider exceeded its output limit. The runner now records such exceptions as failed cases and continues, with a regression test for complete failure reporting.
An exploratory restored-cache run scored 5/6 but returned no recognized model name. It is not included in the Gemma comparison.

These fixtures exercise a small value change. Passing them does not establish readiness for unfamiliar upstream ports.
The earlier two-example run passed 4/6 cases and needed corrective retries.
The current comparison changes prompt size and was measured at a different time, so it does not isolate a causal timing improvement.
Preloading remains rejected. Normal requests use isolated sessions and retain independent proposal validation.

## Verification

The executable coverage run measured 99.42%, and the direct type pass measured 99.80%.
The full coverage suite passed 1,585 tests, with two optional conformance cases skipped.
The separate upstream conformance run completed offline with 5 passes, 75 expected failures, and no unexpected failures.
The repository enforces a 99% executable line coverage floor.
Build, declarations, packed browser/Node consumer checks, and full lint passed.
The public API has 68 focused behavior tests. Controlled Chrome tests cover native cancellation, late completion, overflow, and the storage guard.
Mocked providers cover recovery and cleanup failures. This coverage pass added no exclusions.
These checks establish library behavior. A live model score remains separate from deterministic verification.
