# Performance practices

Measure package bytes, allocated storage, session setup, and response time separately.
Each measurement answers a different question about `@socketsecurity/odai`.

## Measure the package

```sh
pnpm run perf:footprint --output bench/results/footprint.json
pnpm run build
pnpm run check:package
```

The footprint script generates bundles in memory. It does not replace `dist/`.
It records raw bytes, gzip at level 9, and Brotli at quality 11.
It follows static imports and reports additional dynamic chunks separately.
Use the complete import graph when comparing an entry. The small CLI entry also loads shared code.

Runtime dependencies remain part of the application cost even when they are external to the bundle.
The package declares `@sinclair/typebox`. The build keeps value helpers bundled because externalizing them increased measured import cost.
The optional browser benchmark includes the parser needed to check generated JavaScript.
Its bytes do not belong to the normal browser entry.

## Measure retained conversation context

```sh
pnpm run perf:context --api odai --pairs 5 --context-lines 64 --output bench/results/conversation.json
pnpm run perf:context --api native --pairs 5 --context-lines 64 --output bench/results/context.json
```

This experiment uses existing Gemma weights through the Chrome backend. It does not authorize a model download.
Each pair compares one retained native conversation with fresh sessions that replay the same completed history.
The order alternates. Follow-up prompts ask for a code supplied only in the first turn.
Both paths must return the expected code.

The report records bridge setup, first chunk, total response time, and context usage.
The public API timing includes lazy session creation. The native baseline reports session creation separately.
Compare follow-up turns separately from the first turn, which includes initialization.
Text character counts are not token counts. Chrome reports the native context window and usage where available.
Keep failed samples in the report. A faster incorrect response does not qualify as an improvement.

The default command exercises the [public conversation API](../conversation/practices.md).
Use `--api native` to measure the direct Chrome baseline.

## Measure full and sparse lockstep

```sh
pnpm run perf:lockstep --mode per-request --pairs 3 --output bench/results/lockstep-corrected.json
```

The default script evaluates normal request context. Each pair covers full and sparse materialization.
Use `--mode both` to compare it with the rejected preloaded-template experiment.
Normal task behavior remains isolated between requests.
The report records setup, response time, every attempt and raw reply, and fixture results for both materializations.
The task allows at most three attempts and supplies validation feedback after a rejected proposal.
Separate first-attempt success from success after correction.
These small fixtures test patch generation. They do not measure a complete upstream port or conformance suite.

Use the same fixture inputs before and after a change. Keep full and sparse results separate.
Inspect retries as well as elapsed time. Reduced input can still increase total time when the model makes more mistakes.
Do not shorten examples or simplify expected changes to improve the score.

## Measure disk compression

Use immutable copies in a directory under `os.tmpdir()` when evaluating `decmpfs`.
Record logical and allocated bytes before and after compression, and verify the complete output with SHA256.
Large files need the streaming writer to avoid an additional whole-file buffer.
Remove only the temporary copies after measurement.

Filesystem compression changes allocated disk space. It does not reduce JavaScript input bytes or the model's tensor size.
Record the filesystem, native addon hash, and runtime version with the result.
Copy operations can discard filesystem compression. Verify the destination rather than assuming a clone flag preserved it.

## Check an improvement

Run the affected tests first. Then run types, the build, package checks, and the full test suite.
Avoid running these checks during inference timing. They compete for CPU and memory.
Record the power source and machine state. Use repeated, interleaved comparisons on the same installed model.
Keep rejected experiments in the [journal](journal.md) so they do not become recommendations without new evidence.
