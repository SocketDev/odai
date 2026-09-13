# Lockstep assistance

`odai lockstep` reviews one declared lockstep row. The row uses full or sparse materialization.
Both modes use the same task, response contract, and verification rules.
The task proposes a patch or explains why it cannot propose one.
It does not update upstream pins or apply changes to the working tree.

## Prepare evidence

Use the fleet `lockstep:assist` command to collect evidence from immutable Git revisions.
Provide the row identifier and the previous upstream commit explicitly.
The target defaults to the upstream pin in the manifest.
Use `--local`, `--tests`, and `--upstream-path` to narrow the selected files when needed.
Sparse evidence must stay inside the declared sparse cone.

```sh
pnpm run lockstep:assist prepare --row <row-id> --base <commit-sha> --output <work-item.json>
odai lockstep --input <work-item.json>
```

Store generated work items and responses outside the checkout, under a temporary directory.
The work item records both upstream revisions, local files, tests, and declared deviations.
Missing or truncated evidence produces an abstention before a model runs.
Narrow the evidence selection when a complete file exceeds the collection budget.

## Validate the response

The public `parseLockstepInput` and `validateLockstepAnalysis` functions validate the input and response.
A response has a `port`, `no-change`, or `abstain` verdict.
A `port` response needs an upstream citation, a code patch, and an additive test patch.
A `no-change` response still needs a citation. An abstention needs an explanation.
A `port` response must cite the target revision. A `no-change` response must cite every supplied target excerpt.
The previous upstream revision provides historical context. Matching it does not establish that the local implementation matches the target.

Validation checks citation identifiers and line ranges against the supplied evidence.
It does not establish whether the cited text supports the model's conclusion.
Paths must remain inside the declared local and test areas.
The patch parser rejects malformed hunks, path traversal, renames, and file mode changes.
Protected files, including pins and generated outputs, require a separate manual change.

The task allows at most three model attempts. A rejected proposal receives its actual validation diagnostic on the next attempt.
Each attempt uses a fresh request session. Retries inside the structured-output helper are disabled for this task.
The public `validate` option accepts a diagnostic callback for additional checks.
Return a string to reject the analysis, or `undefined` to accept it. The callback can be asynchronous.
For example, a caller can apply proposed changes in memory and parse the result before accepting the response.
The callback does not establish that a full repository test suite passed.

## Verify the proposed change

Run the fleet verifier with the original work item, the response, and a trusted command list.
Commands are explicit argument arrays. A model cannot provide or change that list.
Repeat the mapping overrides used during preparation.

```sh
pnpm run lockstep:assist verify --input <work-item.json> --result <analysis.json> --checks <checks.json> --json
```

The verifier reconstructs the manifest scope and evidence before it checks the response.
It rejects changed evidence and stale local inputs.
It copies tracked files and the selected upstream revision into a physical temporary directory.
Git checks and applies the patch there. The verifier then runs the trusted commands.
It records exit codes and output, and removes the temporary directory when finished.
Dependencies must be installed inside that copy when a check needs them.

The copy keeps ordinary patch application outside the working tree.
It is not an operating system sandbox. Proposed code and installation scripts retain host permissions.
Use an external sandbox when that code is not trusted to execute on the host.
A passing command only establishes the behavior that command checks.
Review the patch and use the row's existing conformance tests before applying it.

## Select and evaluate a model

`lockstep` and `patch` prefer the `llama-server` backend because they require more reasoning.
An explicit backend selection takes precedence over that default.
Use `--backend chrome-builtin` to evaluate the available Chrome model.
Set `ODAI_CHROME_MODEL=gemma4` to select Gemma.
Gemma uses its own profile, and an empty component directory does not count as installed weights.
Batch mode uses one backend for the batch and chooses the reasoning backend when either task appears.

```sh
ODAI_CHROME_MODEL=gemma4 odai lockstep --backend chrome-builtin --input <work-item.json>
ODAI_CHROME_MODEL=gemma4 pnpm run bench --scenario=lockstep --backend=chrome-builtin --timeout=45000 --json
pnpm run bench --scenario=lockstep --routed --json
```

<details>
<summary>How model proposals are checked and scored</summary>

The prompt supplies examples, evidence boundaries, and an abstention rule.
The model describes each edit with a local or test evidence identifier, an inclusive line range, an operation, and new text.
`odai` reads the old lines from trusted evidence and generates the unified diff.
This keeps diff headers and unchanged source text out of the model's output while preserving the public patch response used by the fleet verifier.
This is prompt scaffolding. It does not train or modify model weights.
The full and sparse evaluation cases use values that differ from the prompt examples.
Their scores require valid citations, applicable changes, the expected value, and a regression assertion that uses the changed export.
The evaluator parses the changed files. Equivalent formatting and import aliases can pass.
Separate integration tests apply the generated patches with Git, including files without a final newline.
They do not measure upstream conformance or prove that a model can implement an unfamiliar port.

The default benchmark uses deterministic simulator responses to test the harness.
Use an explicit backend for a model quality measurement and report its actual identity.
An unavailable model or a setup timeout provides no model quality score.
Benchmark success requires every selected scenario to pass.
The package check also exercises the published Node declarations and browser benchmark bundle.

</details>

See [performance practices](../perf/practices.md) for repeated full and sparse measurements and the retained-context experiment.
