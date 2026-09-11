# Gemma model cache

Use `pnpm run ai:odai:cache` to prepare and verify a dedicated Gemma 4 cache.
Every command supports `--describe`, `--help`, and `--json`.
A successful command exits with code zero. Errors exit with a nonzero code.

## Prepare the browser

The external-tool updater discovers Chrome Beta releases through Google's version history.
It selects a release that meets the fleet's seven-day wait and records the archive hash.
It does not lower an existing pin. Applied Chrome updates must pass offline inference before replacing the pin.

The Chrome, sandbox, and decoder pins live in odai’s `.config/repo/external-tools.json`.

Prepare an image from a named Node image with an immutable SHA256 digest:

```sh
pnpm run ai:odai:cache prepare-image \
  --base-image 'node:<version>-slim@sha256:<digest>' \
  --destination .cache/gemma-image \
  --json
```

This stage downloads and verifies Chrome and the sandbox profile.
It copies the installed Playwright package after checking its version against the sandbox pin.
It builds a Linux x64 image and returns `imageId`, `seccompPath`, and `browserPath`.
Model files never enter the image build context.

## Provision and export

Use the returned image ID and sandbox path:

```sh
pnpm run ai:odai:cache provision \
  --image 'sha256:<image-id>' \
  --seccomp .cache/gemma-image/seccomp.json \
  --profile .cache/gemma-profile \
  --json

pnpm run ai:odai:cache export \
  --profile .cache/gemma-profile \
  --destination .cache/gemma-export \
  --json
```

Provisioning permits component downloads. Chrome keeps its sandbox enabled.
The Linux CPU path requires four cores, 15,000 MiB RAM, and 22 GiB free disk space.
The command checks capacity before starting Chrome and limits startup time.

The profile must be new or carry this command's ownership marker.
Export rejects an active Chrome profile and symlinks.
It copies only model directories and creates clean activation settings.
It excludes browsing history, cookies, credentials, and hardware-specific eligibility data.
The manifest records the model files, their sizes, and their SHA256 hashes.

## Verify without networking

```sh
pnpm run ai:odai:cache verify \
  --image 'sha256:<image-id>' \
  --seccomp .cache/gemma-image/seccomp.json \
  --profile .cache/gemma-export \
  --destination .cache/gemma-verification \
  --json
```

Verification checks the export hashes and creates a separate copy.
The container runs as a non-root user with `--network none` and Chrome's sandbox enabled.
The browser worker also rejects a non-loopback network interface.
A real prompt must identify Gemma 4, and Chrome must retain the Gemma selection flag.
This checks the model's reported identity. It is not cryptographic proof of model identity.

A successful provision does not prove that an exported cache works offline.
Only a successful verification proves that the tested image can use that copy without networking.
A Linux x64 container on Apple silicon also tests the local emulation path.
It does not prove performance on a native Linux runner.

## Verify Chrome updates

`pnpm run update` checks changed Chrome candidates through `scripts/repo/update/chrome.mts` before writing their pins.
The direct external-tool updater uses the same check. Dry runs and unchanged candidates do not start inference.

Prepare and export a working model with the current browser first. Then provide that export and an immutable base image:

```sh
export ODAI_CACHE_PROFILE="$PWD/.cache/gemma-export"
export ODAI_CACHE_BASE_IMAGE='node:<version>-slim@sha256:<digest>'
pnpm run update
```

Set `ODAI_CACHE_BUILDER` when Docker needs a named builder.
The verifier checks model hashes before building the complete, integrity-verified candidate package.
It uses a fresh profile copy, forces CPU inference, keeps the sandbox enabled, and disables container networking.
Inference has a 60-second limit. Image preparation and model copying take additional time.
The reported browser version must match the candidate and the prompt must produce a valid Gemma response.

Missing prerequisites, crashes, invalid responses, and timeouts fail the update and preserve the current Chrome pin.
Other tool updates can succeed. A failed required check still makes the overall command exit nonzero.
The verifier removes its temporary files and retains Docker's shared build cache.

## Audit before upload

Run `pnpm run ai:odai:cache upload --archive <file.tar.gz> --release-tag gemma-cache-<name> --json` against an empty draft release.
The command audits the complete archive before it accesses GitHub.
It splits accepted archives into bounded parts and returns the manifest SHA256 for CI.

Archives contain `image.tar`, `image-id`, `seccomp.json`, and the sanitized export under `profile/`.
The audit rejects macOS metadata, unsafe paths, duplicate entries, links, special files, and missing required files.
It limits expanded bytes and entry counts without extracting files.
Python 3 supplies the archive parser. A missing parser fails the command.

Use `audit-archive --archive <file.tar.gz> --json` to run the same check without uploading.
When creating archives on macOS, set `COPYFILE_DISABLE=1` and use tar's `--no-mac-metadata --no-xattrs` options.
The audit remains required even when archive creation suppresses metadata.

## Retained diagnostics

Add `--diagnostics <new-directory>` to a container verification run to retain bounded native logs, crash reports, and resource context.
The directory remains available after container and temporary profile cleanup.
Chrome update verification saves evidence under `.cache/fleet/ai/odai/diagnostics`. Set `ODAI_CACHE_DIAGNOSTICS` to choose another absolute directory.
A failed update reports the evidence path. Files remain private; environment variables and credentials are not dumped.

Use `pnpm run ai:odai:diagnose --help` to inspect retained crashes, kernel messages, or a replay archive.
Every command supports `--describe` and `--json`. Evidence inspection does not claim that inference passed.
