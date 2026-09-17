#!/usr/bin/env node
/*
 * @file Dep-0 fleet "prepare doctor". The consumer's `prepare` lifecycle runs
 *   this AFTER pnpm installs root deps (npm runs `prepare` post-install) — the
 *   only point where the fetched fleet payload exists AND the package manager
 *   is available, so it is where a thin member self-heals its wiring:
 *
 *   1. Fetch + apply the pinned fleet bundle when the consumer isn't current
 *      (delegates to `scripts/repo/bootstrap/fleet.mjs --if-current`). On a fresh clone this
 *      materializes the untracked fleet payload — the per-hook and oxlint-rule
 *      workspace packages the first install couldn't see.
 *   2. Repair `pnpm-workspace.yaml`: ensure every fleet workspace dir is listed
 *      under `packages:` so pnpm resolves those now-present packages.
 *      Idempotent — a no-op once the consumer already carries them.
 *   3. `pnpm install --ignore-scripts` — a reconcile pass that links the
 *      freshly-materialized workspace packages into node_modules. The FIRST
 *      install ran before the payload existed; this pass is what wires it.
 *      `--ignore-scripts` stops the pass from re-entering `prepare` (which
 *      would loop) and is safe because fleet packages have no build step. Bare
 *      node only — the dep-0 bootstrap never imports socket-lib (documented +
 *      enforced; everything else in the fleet uses socket-lib). Each repair is
 *      a pure, unit-tested function; this file orchestrates them and shells
 *      out. Extend it with further check-and-repair steps as the wired-settings
 *      surface grows. USAGE: node scripts/repo/bootstrap/prepare.mts
 */

// Dep-0 bare-node fetcher (documented invariant: never imports in-repo
// socket-lib): shells out to pnpm via node:child_process, and execFileSync's
// throw-on-nonzero gates the reconcile step — the lib spawn wrapper (async,
// non-throwing) would re-plumb the error handling.
// oxlint-disable-next-line socket/prefer-spawn-over-execsync -- dep-0 bare-node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { execFileSync as pnpmExecFileSync } from 'node:child_process'
import pnpmCrypto from 'node:crypto'
import {
  closeSync as pnpmCloseSync,
  constants as pnpmConstants,
  fstatSync as pnpmFstatSync,
  lstatSync as pnpmLstatSync,
  opendirSync as pnpmOpendirSync,
  openSync as pnpmOpenSync,
  readSync as pnpmReadSync,
  realpathSync as pnpmRealpathSync,
} from 'node:fs'
import type { Dirent as PnpmDirectoryEntry } from 'node:fs'
import pnpmPath from 'node:path'
import pnpmProcess from 'node:process'
const { pnpmEcosystemFingerprint } = (function () {
  // The install fingerprint and Actions cache resolve before npm dependencies exist.
  // oxlint-disable-next-line socket/prefer-spawn-over-execsync -- dep-0 config query

  interface PnpmEcosystemOwnership {
    cargo: boolean
    python: boolean
  }

  interface PnpmEcosystemOptions {
    config?: unknown | undefined
    maxBytes?: number | undefined
    maxEntries?: number | undefined
  }

  interface PnpmDirectoryIdentity {
    readonly dev: number
    readonly ino: number
  }
  interface PnpmEcosystemScan {
    readonly root: string
    readonly files: string[]
    readonly directories: Map<string, PnpmDirectoryIdentity>
  }

  const PNPM_CONFIG_TIMEOUT_MS = 30_000
  const PNPM_CONFIG_MAX_BYTES = 1_048_576
  const PNPM_INPUT_MAX_ENTRIES = 50_000
  const PNPM_INPUT_MAX_BYTES = 16 * 1024 * 1024
  const PNPM_INPUT_SKIP_DIRS = new Set([
    '.cache',
    '.git',
    '.pnpm',
    '.venv',
    'build',
    'coverage',
    'deps',
    'external',
    'fixtures',
    'node_modules',
    'target',
    'third_party',
    'upstream',
    'vendor',
  ])

  function pnpmConfigRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  function pnpmEcosystemOwnership(config: unknown): PnpmEcosystemOwnership {
    if (!pnpmConfigRecord(config)) {
      throw new TypeError(
        'Invalid pnpm configuration. Where: ecosystem ownership. Saw a non-object; wanted parsed pnpm config. Fix the workspace configuration.',
      )
    }
    const ownership = { cargo: false, python: false }
    for (const name of ['cargo', 'python'] as const) {
      const section = config[name]
      if (section === undefined || section === null) {
        continue
      }
      if (
        !pnpmConfigRecord(section) ||
        (section['enabled'] !== undefined &&
          typeof section['enabled'] !== 'boolean')
      ) {
        throw new TypeError(
          `Invalid pnpm ${name} setting. Where: ecosystem ownership. Wanted an enabled boolean. Fix pnpm-workspace.yaml.`,
        )
      }
      ownership[name] = section['enabled'] === true
    }
    return ownership
  }

  function readPnpmEcosystemOwnership(
    root: string,
    options: PnpmEcosystemOptions = {},
  ): PnpmEcosystemOwnership {
    if (options.config !== undefined) {
      return pnpmEcosystemOwnership(options.config)
    }
    const args = ['config', 'list', '--json']
    const windows = pnpmProcess.platform === 'win32'
    let config: unknown
    try {
      config = JSON.parse(
        pnpmExecFileSync(
          windows ? 'bash' : 'pnpm',
          windows ? ['-c', 'exec pnpm "$@"', 'pnpm', ...args] : args,
          {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: PNPM_CONFIG_MAX_BYTES,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: PNPM_CONFIG_TIMEOUT_MS,
          },
        ),
      )
    } catch (error) {
      const code = pnpmConfigFailureCode(error)
      throw Object.assign(
        new Error(
          `Cannot read pnpm ecosystem ownership. Where: pnpm config list --json. Saw ${code}; wanted valid configuration within ${PNPM_CONFIG_TIMEOUT_MS}ms. Fix pnpm setup or workspace configuration and retry.`,
        ),
        { code },
      )
    }
    return pnpmEcosystemOwnership(config)
  }

  function pnpmConfigFailureCode(error: unknown): string {
    if (pnpmConfigRecord(error)) {
      switch (error['code']) {
        case 'EACCES':
        case 'ENOENT':
        case 'ENOBUFS':
        case 'ETIMEDOUT':
          return error['code']
      }
    }
    return error instanceof SyntaxError ? 'INVALID_JSON' : 'CONFIG_FAILED'
  }

  function isPnpmInputDirectory(name: string): boolean {
    return (
      !PNPM_INPUT_SKIP_DIRS.has(name) &&
      !name.endsWith('-bundled') &&
      !name.endsWith('-vendored')
    )
  }

  function capturePnpmDirectory(directory: string): PnpmDirectoryIdentity {
    const metadata = pnpmLstatSync(directory)
    if (!metadata.isDirectory() || pnpmRealpathSync(directory) !== directory) {
      throw new Error(
        `Pnpm input directory changed. Where: ${directory}. Wanted a contained directory without symlinks. Retry after edits finish.`,
      )
    }
    return {
      __proto__: null,
      dev: metadata.dev,
      ino: metadata.ino,
    } as PnpmDirectoryIdentity
  }

  function assertPnpmDirectories(
    directory: string,
    scan: Pick<PnpmEcosystemScan, 'root' | 'directories'>,
  ): void {
    let current = directory
    while (true) {
      const expected = scan.directories.get(current)
      const actual = capturePnpmDirectory(current)
      if (
        !expected ||
        expected.dev !== actual.dev ||
        expected.ino !== actual.ino
      ) {
        throw new Error(
          `Pnpm input directory changed. Where: ${current}. Wanted the directory recorded during discovery. Retry after edits finish.`,
        )
      }
      if (current === scan.root) {
        return
      }
      current = pnpmPath.dirname(current)
    }
  }

  function pnpmEcosystemFiles(
    root: string,
    ownership: PnpmEcosystemOwnership,
    options: PnpmEcosystemOptions = {},
  ): string[] {
    return collectPnpmEcosystemFiles(root, ownership, options).files
  }

  function collectPnpmEcosystemFiles(
    root: string,
    ownership: PnpmEcosystemOwnership,
    config: PnpmEcosystemOptions,
  ): PnpmEcosystemScan {
    const names = new Set<string>()
    if (ownership.cargo) {
      names.add('Cargo.toml')
      names.add('Cargo.lock')
    }
    if (ownership.python) {
      names.add('pyproject.toml')
      names.add('pylock.toml')
    }
    if (names.size === 0) {
      return {
        __proto__: null,
        root,
        directories: new Map<string, PnpmDirectoryIdentity>(),
        files: [],
      } as PnpmEcosystemScan
    }
    root = pnpmRealpathSync(root)
    const scan = {
      root,
      directories: new Map([[root, capturePnpmDirectory(root)]]),
    }
    const { maxEntries = PNPM_INPUT_MAX_ENTRIES } = {
      __proto__: null,
      ...config,
    } as PnpmEcosystemOptions
    const stack = ['']
    const files: string[] = []
    let count = 0
    while (stack.length) {
      const relative = stack.pop()
      if (relative === undefined) {
        break
      }
      const directoryPath = pnpmPath.join(root, relative)
      assertPnpmDirectories(directoryPath, scan)
      const directory = pnpmOpendirSync(directoryPath)
      try {
        assertPnpmDirectories(directoryPath, scan)
        let entry: PnpmDirectoryEntry | null
        while ((entry = directory.readSync()) !== null) {
          count += 1
          if (count > maxEntries) {
            throw new Error(
              `Cannot fingerprint pnpm ecosystem inputs. Where: ${root}. Saw more than ${maxEntries} entries. Fix the workspace layout or its vendor exclusions.`,
            )
          }
          if (entry.isSymbolicLink()) {
            continue
          }
          const child = relative ? `${relative}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            if (isPnpmInputDirectory(entry.name)) {
              const childPath = pnpmPath.join(root, child)
              scan.directories.set(childPath, capturePnpmDirectory(childPath))
              stack.push(child)
            }
          } else if (entry.isFile() && names.has(entry.name)) {
            files.push(child)
          }
        }
      } finally {
        directory.closeSync()
      }
    }
    return {
      __proto__: null,
      ...scan,
      files: files.toSorted(),
    } as PnpmEcosystemScan
  }

  function readPnpmInput(
    file: string,
    remainingBytes: number,
    scan: PnpmEcosystemScan,
  ): Buffer {
    const parent = pnpmPath.dirname(file)
    assertPnpmDirectories(parent, scan)
    const metadata = pnpmLstatSync(file)
    if (!metadata.isFile() || metadata.size > remainingBytes) {
      throw new Error(
        `Cannot fingerprint pnpm ecosystem input. Where: ${file}. Wanted a regular file within the remaining ${remainingBytes} bytes. Fix the workspace inputs.`,
      )
    }
    const flags =
      pnpmConstants.O_RDONLY |
      (pnpmConstants.O_NOFOLLOW ?? 0) |
      (pnpmConstants.O_NONBLOCK ?? 0)
    const descriptor = pnpmOpenSync(file, flags)
    try {
      assertPnpmDirectories(parent, scan)
      const opened = pnpmFstatSync(descriptor)
      if (
        !opened.isFile() ||
        opened.size !== metadata.size ||
        opened.ino !== metadata.ino ||
        opened.dev !== metadata.dev
      ) {
        throw new Error(
          `Pnpm input changed while opening. Where: ${file}. Wanted a stable regular file. Retry after edits finish.`,
        )
      }
      const bytes = Buffer.alloc(metadata.size)
      let offset = 0
      while (offset < bytes.length) {
        const count = pnpmReadSync(
          descriptor,
          bytes,
          offset,
          bytes.length - offset,
          offset,
        )
        if (count === 0) {
          throw new Error(
            `Pnpm input changed while reading. Where: ${file}. Wanted complete file bytes. Retry after edits finish.`,
          )
        }
        offset += count
      }
      if (pnpmReadSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
        throw new Error(
          `Pnpm input grew while reading. Where: ${file}. Wanted stable file bytes. Retry after edits finish.`,
        )
      }
      assertPnpmDirectories(parent, scan)
      return bytes
    } finally {
      pnpmCloseSync(descriptor)
    }
  }

  function pnpmEcosystemFingerprint(
    root: string,
    options: PnpmEcosystemOptions = {},
  ): string {
    const ownership = readPnpmEcosystemOwnership(root, options)
    if (!ownership.cargo && !ownership.python) {
      return ''
    }
    const hash = pnpmCrypto
      .createHash('sha256')
      .update(JSON.stringify(ownership))
    const maxBytes = options.maxBytes ?? PNPM_INPUT_MAX_BYTES
    let totalBytes = 0
    const scan = collectPnpmEcosystemFiles(root, ownership, options)
    for (const relative of scan.files) {
      const bytes = readPnpmInput(
        pnpmPath.join(scan.root, relative),
        maxBytes - totalBytes,
        scan,
      )
      totalBytes += bytes.length
      hash.update(JSON.stringify([relative, bytes.length])).update(bytes)
    }
    return hash.digest('hex')
  }

  const pnpmBootstrapApi = {
    pnpmEcosystemOwnership,
    readPnpmEcosystemOwnership,
    pnpmEcosystemFiles,
    pnpmEcosystemFingerprint,
  }
  return pnpmBootstrapApi
})()

import { readFileSync as bootstrapReadFileSync } from 'node:fs'
import bootstrapProcess from 'node:process'
const bootstrapRunner = (function (
  readFileSync: typeof bootstrapReadFileSync,
  process: typeof bootstrapProcess,
) {
  interface ScriptResult {
    readonly exitCode: number
    readonly data?: unknown | undefined
    readonly error?: string | undefined
  }

  function renderScriptResult(result: ScriptResult): string {
    if (
      !Number.isInteger(result.exitCode) ||
      result.exitCode < 0 ||
      result.exitCode > 255
    ) {
      throw new Error(
        'Script result requires an integer exit code between 0 and 255.',
      )
    }
    return JSON.stringify({
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(result.error === undefined ? {} : { error: result.error }),
    })
  }

  class ScriptExit extends Error {
    readonly exitCode: number

    constructor(exitCode: number) {
      if (!Number.isInteger(exitCode) || exitCode < 1 || exitCode > 255) {
        throw new Error(
          'Script abort requires an integer exit code between 1 and 255.',
        )
      }
      super(
        `Script stopped with exit code ${exitCode}. Review the preceding diagnostic and retry.`,
      )
      this.name = 'ScriptExit'
      this.exitCode = exitCode
    }
  }

  function abortScript(exitCode: number): never {
    throw new ScriptExit(exitCode)
  }

  /**
   * True when argv carries a bare `--`.
   *
   * `pnpm run <script> -- --flag` forwards the `--` to the script, and the argv
   * parser truncates there — every flag after it is DISCARDED, not collected as
   * a positional. The script then runs with default behaviour while the caller
   * believes they passed flags. That is merely confusing for a read-only script
   * and dangerous for a destructive one: `prune:branch-backups -- --dry-run`
   * drops the `--dry-run` and performs a live run against every repo.
   *
   * Checked against `process.argv` because by the time parsing finishes the
   * dropped flags are unrecoverable — the parsed result cannot tell you what
   * was lost.
   */
  function hasBareDoubleDash(argv: readonly string[]): boolean {
    return argv.includes('--')
  }

  /**
   * The message shown when argv carries a bare `--`. Names the script so the
   * corrected command can be pasted directly.
   */
  function bareDoubleDashMessage(scriptName: string): string {
    return (
      'a bare `--` in the command line\n' +
      `  Where: the argv for ${scriptName}.\n` +
      '  Saw:   flags after `--`. The argv parser truncates there, so those ' +
      'flags were NOT applied and the script ran with its defaults.\n' +
      `  Fix:   drop the \`--\`, e.g. \`pnpm run ${scriptName} --dry-run\`.`
    )
  }

  /**
   * A script's self-description, answered without running its side effect.
   * `--describe` prints `describe` verbatim — one line, what the script does —
   * so script inventories and agents can read purpose without opening the file.
   * `-h`/`--help` prints `describe`, a blank line, then `help`, which opens
   * with a `Usage:` line naming the sanctioned invocation and lists the flags
   * `main()` actually parses.
   */
  interface ScriptMeta {
    readonly heavyJob?: 'test' | 'coverage' | 'build' | 'type' | undefined
    readonly json?: 'native' | 'result' | undefined
    readonly describe: string
    readonly help: string
  }

  /**
   * The help request found on argv, if any: `--describe` wins over
   * `-h`/`--help` when both are present (the narrower ask costs one line;
   * printing both forms for a mixed argv helps no caller). Pure — exported for
   * tests.
   */
  function helpRequest(
    argv: readonly string[],
  ): 'describe' | 'help' | undefined {
    if (argv.includes('--describe')) {
      return 'describe'
    }
    if (argv.includes('-h') || argv.includes('--help')) {
      return 'help'
    }
    return undefined
  }

  /**
   * True when argv carries `--json` on its own — orthogonal to `helpRequest`,
   * which only reads `--describe`/`-h`/`--help`. A script's own `main()` calls
   * this to switch its RESULT output to structured JSON without re-parsing
   * argv itself; `--describe --json` (either order) is answered entirely by
   * the runner before `main()` runs and never reaches this predicate. Pure —
   * exported for tests and entry scripts.
   */
  function isJsonRequested(argv: readonly string[]): boolean {
    return argv.includes('--json')
  }

  /**
   * The text a help request prints: the one-liner alone for `--describe`, or
   * the one-liner + blank line + usage body for `--help`. Pure — exported for
   * tests.
   */
  function helpText(kind: 'describe' | 'help', meta: ScriptMeta): string {
    return kind === 'describe'
      ? meta.describe
      : `${meta.describe}\n\n${meta.help}`
  }

  /**
   * The `--describe --json` payload: the fleet CLI self-description manifest
   * (canonical schema: socket-wheelhouse `schemas/cli-describe.schema.json`),
   * minimal for a script — identity plus the one-line purpose; a script's flags
   * live in its `help` prose, not structured meta. Pure — exported for tests.
   */
  interface DescribeIdentity {
    readonly name: string
    readonly version: string
  }

  function describeManifestText(
    meta: ScriptMeta,
    config: DescribeIdentity,
  ): string {
    const { name, version } = { __proto__: null, ...config } as DescribeIdentity
    return JSON.stringify(
      {
        $schema:
          'https://raw.githubusercontent.com/SocketDev/socket-wheelhouse/main/schemas/cli-describe.schema.json',
        name,
        version,
        description: meta.describe,
      },
      undefined,
      2,
    )
  }

  function errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }
    return String(error)
  }

  type MainFn = () =>
    | number
    | void
    | ScriptResult
    | Promise<number | void | ScriptResult>

  function scriptVersion(): string {
    try {
      const value: unknown = JSON.parse(readFileSync('package.json', 'utf8'))
      if (
        value !== null &&
        typeof value === 'object' &&
        'version' in value &&
        typeof value.version === 'string'
      ) {
        return value.version
      }
    } catch {}
    return '0.0.0'
  }

  function writeLine(text: string): void {
    process.stdout.write(`${text}\n`)
  }

  function runMainMinimal(main: MainFn, meta: ScriptMeta): void {
    void runMainMinimalAsync(main, meta)
  }

  async function runMainMinimalAsync(
    main: MainFn,
    meta: ScriptMeta,
  ): Promise<void> {
    const argv = process.argv.slice(2)
    const json = isJsonRequested(argv)
    const request = helpRequest(argv)
    const name = process.argv[1]?.split('/').pop() ?? 'script'
    if (request) {
      writeLine(
        request === 'describe' && json
          ? describeManifestText(meta, { name, version: scriptVersion() })
          : helpText(request, meta),
      )
      process.exitCode = 0
      return
    }
    try {
      if (hasBareDoubleDash(argv)) {
        throw new Error(bareDoubleDashMessage(name))
      }
      if (json && !meta.json) {
        throw new Error('This script has not declared JSON execution support.')
      }
      await invokeMinimalMain(main, meta)
    } catch (error) {
      const message = errorMessage(error)
      const exitCode = error instanceof ScriptExit ? error.exitCode : 1
      process.exitCode = exitCode
      if (json) {
        writeLine(renderScriptResult({ exitCode, error: message }))
      } else {
        process.stderr.write(`${message}\n`)
      }
    }
  }

  async function invokeMinimalMain(
    main: MainFn,
    meta: ScriptMeta,
  ): Promise<void> {
    const json = isJsonRequested(process.argv.slice(2))
    const result = await main()
    const code =
      typeof result === 'object' && result !== null ? result.exitCode : result
    if (typeof code === 'number') {
      process.exitCode = code
    } else if (!process.exitCode) {
      process.exitCode = 0
    }
    if (json && meta.json === 'result') {
      writeLine(
        renderScriptResult({
          ...(typeof result === 'object' && result !== null ? result : {}),
          exitCode: Number(process.exitCode ?? 0),
        }),
      )
    } else if (!json && typeof result === 'object' && result?.error) {
      process.stderr.write(`${result.error}\n`)
    }
  }

  return { runMainMinimal, abortScript }
})(bootstrapReadFileSync, bootstrapProcess)
const { runMainMinimal } = bootstrapRunner
type ScriptMeta = Parameters<typeof runMainMinimal>[1]

const SCRIPT_META: ScriptMeta = {
  describe:
    'Prepare a thin fleet checkout and repair its workspace dependencies.',
  help: 'Usage: node scripts/repo/bootstrap/prepare.mts [--hydrate-only | --pipeline] [--json]',
  json: 'result',
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Function declarations hoist, so the sorted-position definition below is
// usable here.
const REPO_ROOT = resolveRepoRoot(HERE)

/**
 * Fleet workspace package globs every member lists under `pnpm-workspace.yaml`
 * `packages:`. They resolve the (fetched, gitignored) fleet payload packages —
 * the per-hook dirs and the oxlint-rule ("rules") sub-packages. This is the
 * dep-0 doctor's source of truth; the bundle's workspace segment seeds the same
 * set on fetch, and this re-asserts them on every prepare so a drifted or
 * freshly-cloned consumer self-heals.
 */
export const FLEET_WORKSPACE_PACKAGES: readonly string[] = [
  '.claude/hooks/fleet/*',
  '.claude/hooks/repo/*',
  '.config/fleet/oxlint-plugin/fleet/*',
  '.config/repo/oxlint-plugin/*',
]

/**
 * Ensure every glob in `required` appears under the `packages:` block of a
 * `pnpm-workspace.yaml`. Pure + idempotent: returns the YAML unchanged when all
 * are present, else appends the missing entries at the end of the existing
 * block (preserving order + the 2-space single-quoted bullet style). Creates a
 * `packages:` block at the top when the file has none. Repo-specific entries
 * already in the block are preserved.
 */
export function ensureWorkspacePackages(
  yaml: string,
  required: readonly string[],
): string {
  const lines = yaml.split('\n')
  const blockIdx = lines.findIndex(l => l.trimEnd() === 'packages:')
  const present = new Set<string>()
  // Index to splice missing bullets at: right AFTER the last existing bullet
  // (so they join the list, not land past a trailing blank line / comment).
  let insertAt = -1
  if (blockIdx !== -1) {
    insertAt = blockIdx + 1
    for (let i = blockIdx + 1; i < lines.length; i += 1) {
      const ln = lines[i]!
      // The block ends at the first non-indented, non-blank line.
      if (ln !== '' && !/^\s/.test(ln)) {
        break
      }
      // ^\s*-\s*        a YAML list bullet
      // ['"]?(...)['"]?  the (optionally quoted) glob value
      // \s*(?:#.*)?$     optional trailing inline comment
      const m = /^\s*-\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/.exec(ln)
      if (m) {
        present.add(m[1]!)
        insertAt = i + 1
      }
    }
  }
  const missing = required.filter(r => !present.has(r))
  if (missing.length === 0) {
    return yaml
  }
  const bullets = missing.map(m => `  - '${m}'`)
  if (blockIdx === -1) {
    return [`packages:`, ...bullets, '', ...lines].join('\n')
  }
  return [
    ...lines.slice(0, insertAt),
    ...bullets,
    ...lines.slice(insertAt),
  ].join('\n')
}

/**
 * Step 1: fetch + apply the pinned bundle when not current (best-effort).
 *
 * Guards against downgrading a newer applied pack: `maybeNotifyUpdate` (which
 * runs AFTER this in `runPrepare`) opportunistically applies the newest ref it
 * resolves, but does NOT update the config pin. Without this guard, the next
 * install's `fleet.mjs --if-current` sees `appliedRef !== pinnedRef` and
 * re-applies the OLD pin, reverting the auto-update — wasted work every cycle.
 * The guard skips the fetch when the applied ref is at or ahead of the pin, so
 * a newer applied pack is never downgraded to the pin outside CI. CI behavior
 * is unchanged: `maybeNotifyUpdate` is suppressed there, so the applied ref
 * always matches the pin and the guard is never consulted.
 */
export function fetchBundle(): void {
  const fleet = path.join(HERE, 'fleet.mjs')
  if (!existsSync(fleet)) {
    log('no scripts/repo/bootstrap/fleet.mjs beside me — skipping bundle fetch')
    return
  }
  // The PRODUCER branch. A checkout carrying `template/base/universal` holds the canon
  // locally: there is no bundle to fetch and no pin to compare, so it
  // materializes from its own template instead. Everything after this step —
  // the pnpm-workspace repair and the reconcile install — is identical, and is
  // exactly what a producer needs too: the mirrors it just placed include ~380
  // workspace package.json files that the first install could not see.
  // Branching here rather than writing a second doctor keeps one code path.
  if (existsSync(path.join(REPO_ROOT, 'template', 'base', 'universal'))) {
    if (!tryRun('node', [fleet, '--from-template'])) {
      log(
        'materialize (fleet.mjs --from-template) reported a problem — continuing',
      )
    }
    return
  }
  if (!tryRun('node', [fleet])) {
    log('bundle refresh (fleet.mjs) reported a problem — continuing')
    return false
  }
  if (appliedRef === pinnedRef) {
    return true
  }
  const pinnedSha = packTemplateShaLocal(pinnedRef)
  const appliedSha = packTemplateShaLocal(appliedRef)
  if (!pinnedSha || !appliedSha) {
    return false
  }
  const wheelhouse = path.join(REPO_ROOT, '..', 'socket-wheelhouse')
  if (existsSync(path.join(wheelhouse, '.git'))) {
    try {
      execFileSync(
        'git',
        ['merge-base', '--is-ancestor', pinnedSha, appliedSha],
        {
          cwd: wheelhouse,
          stdio: 'ignore',
        },
      )
      return true
    } catch {
      return false
    }
  }
  return !process.env['CI']
}

export function isMainModule(): boolean {
  const entry = process.argv[1]
  if (!entry) {
    return false
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    return false
  }
}

export function log(message: string): void {
  // Dep-0 bootstrap prepare doctor runs on a bare clone with no node_modules:
  // cannot import the lib logger; console.log writes to STDOUT.
  // oxlint-disable-next-line socket/no-console-prefer-logger -- dep-0 bootstrap
  console.log(`fleet-prepare: ${message}`)
}

/**
 * How long a release-freshness lookup stays good. Mirrors the fetcher's own
 * notice throttle (24h) and shares its store, so the network call and the
 * display are gated by ONE window instead of the call running every time and
 * the display being throttled after the fact.
 */
const NOTICE_CHECK_TTL_MS = 864e5

/**
 * How long to wait before retrying after a lookup that answered nothing.
 *
 * A registry hiccup or an offline laptop must not blind a member for a full
 * day, so the failed lookup is stamped as though it happened long enough ago
 * that the next install retries within the hour. Short enough to recover from
 * a blip, long enough that a genuinely offline machine is not retrying on
 * every install in a loop.
 */
const OFFLINE_RETRY_TTL_MS = 36e5

/**
 * Opportunistic update: when this cheaply learns a newer release exists, it
 * APPLIES that ref and then fires the throttled boxed notice on STDERR via the
 * fetcher's own notice machinery.
 *
 * Checking and then telling the operator to go re-cascade left every member
 * stale until somebody acted on a message, so the check does the update it
 * discovered. `fetchBundle` still applies the PINNED ref on every install; this
 * is what moves the pin forward.
 *
 * Best-effort throughout: offline, no gh, or a failed apply is swallowed so a
 * `pnpm install` never breaks on it, and the run continues.
 *
 * The CI-suppress, opt-out, and 24h throttle are checked BEFORE the GitHub
 * lookup, so they gate the apply as well as the display: no CI runner updates
 * itself, an opted-out operator is never touched, and no member updates more
 * than once a day.
 */
export async function maybeNotifyUpdate(): Promise<void> {
  const fleet = path.join(HERE, 'fleet.mjs')
  if (!existsSync(fleet)) {
    return
  }
  try {
    const {
      UPDATE_NOTIFIER_OPT_OUT_ENV,
      maybeShowUpdateNotice,
      readBundleConfig,
      readNoticeStore,
      resolveNewestRef,
      writeNoticeStore,
    } =
      // oxlint-disable-next-line socket/no-dynamic-import-outside-bundle -- dep-0 bootstrap resolves the fetcher lazily; a static import would execute it on every prepare run
      (await import(pathToFileURL(fleet).href)) as {
        UPDATE_NOTIFIER_OPT_OUT_ENV: string
        maybeShowUpdateNotice: (o: {
          dest: string
          updateAvailable: boolean
          newestRef: string | undefined
        }) => boolean
        readBundleConfig: (dest: string) => {
          ref: string | undefined
          cascadeSha: string | undefined
        }
        readNoticeStore: (
          dest: string,
        ) =>
          | { lastCheckMs: number; lastSeenRef: string | undefined }
          | undefined
        resolveNewestRef: (repo: string) => Promise<string | undefined>
        writeNoticeStore: (
          dest: string,
          store: { lastCheckMs: number; lastSeenRef: string | undefined },
        ) => void
      }
    const cfg = readBundleConfig(REPO_ROOT)
    if (!cfg.ref) {
      return
    }
    // Gate the NETWORK CALL, not just the display. `resolveNewestRef` reaches
    // the GHCR registry (two anonymous requests: a pull token, then the
    // `latest` manifest), and the CI-suppress / opt-out / 24h throttle inside
    // `shouldShowNotice` ran AFTER it — so every `pnpm install`, in every CI
    // job, paid for a lookup whose result was then discarded. At fleet scale
    // that is the shape that earns an anonymous-pull rate limit.
    //
    // In CI and under the opt-out nothing may be applied or printed, so the
    // call is pure waste and is skipped outright. Otherwise honor the same 24h
    // window the display uses.
    //
    // The tradeoff is deliberate: a release cut inside the window is not picked
    // up until the window closes. That costs freshness, never correctness — the
    // PINNED bundle is still applied on every install by `fetchBundle`
    // (`fleet.mjs --if-current`), in CI and locally alike, so a member is never
    // running unverified or half-applied scaffolding while it waits.
    if (process.env['CI'] || process.env[UPDATE_NOTIFIER_OPT_OUT_ENV]) {
      return
    }
    const store = readNoticeStore(REPO_ROOT)
    if (
      store !== undefined &&
      Date.now() - store.lastCheckMs < NOTICE_CHECK_TTL_MS
    ) {
      return
    }
    const repo = 'SocketDev/socket-wheelhouse'
    const newestRef = await resolveNewestRef(repo)
    // STAMP EVERY ANSWER, including the two that change nothing.
    //
    // Writing it only from `maybeShowUpdateNotice` below would reach the store
    // only when an update was actually found. For a member that is already
    // current - the steady state, and the overwhelmingly common one -
    // `lastCheckMs` would never advance, the TTL gate above would never fire,
    // and the registry lookup would run on EVERY `pnpm install`. The throttle
    // only ever engaged for members that were behind, which are the ones least
    // in need of throttling.
    //
    // A lookup that answered nothing is stamped short (see
    // OFFLINE_RETRY_TTL_MS) so an outage costs an hour of freshness, not a day.
    writeNoticeStore(REPO_ROOT, {
      lastCheckMs:
        newestRef === undefined
          ? Date.now() - NOTICE_CHECK_TTL_MS + OFFLINE_RETRY_TTL_MS
          : Date.now(),
      lastSeenRef: newestRef,
    })
    if (newestRef === undefined || newestRef === cfg.ref) {
      return
    }
    // A newer tag exists than the pinned ref, so APPLY it rather than only
    // saying so. A notice naming a re-cascade the operator has to run by hand is
    // a to-do item: it costs a read on every install and the member stays stale
    // until somebody acts on it.
    //
    // Safe because the apply is the SAME verified path `fetchBundle` uses —
    // every file's SHA-256 checked against the manifest, nothing written unless
    // the whole set matches — so applying a newer ref is no riskier than
    // applying the pinned one.
    //
    // Everything that gates the LOOKUP gates the apply: CI, the opt-out env, and
    // the 24h window are all checked above. So this cannot fire on a CI runner,
    // cannot fire for an operator who opted out, and cannot fire more than once
    // a day. The notice still prints, now reporting what happened rather than
    // what to go do.
    const applied = tryRun('node', [fleet, '--ref', newestRef])
    if (!applied) {
      log(`bundle update to ${newestRef} reported a problem — continuing`)
    }
    maybeShowUpdateNotice({
      dest: REPO_ROOT,
      newestRef,
      updateAvailable: true,
    })
  } catch {
    // Best-effort: offline / no gh / a status hard-fail never breaks install.
  }
}

/**
 * Extract the template SHA from a fleet-pack ref (`fleet-pack-<40-hex-sha>`).
 * Mirrors the fetcher's `packTemplateSha` so this file stays dep-0 (no
 * `fleet.mjs` import for a pure string parse). Returns undefined when the ref
 * is not a valid pack ref.
 */
function packTemplateShaLocal(ref: string): string | undefined {
  return /^fleet-pack-(?<sha>[0-9a-f]{40})$/.exec(ref)?.groups?.['sha']
}

/**
 * Read the applied ref from the marker file. Returns undefined when no marker
 * exists. Mirrors the fetcher's `readAppliedRef` so `fetchBundle` can compare
 * without importing the fetcher module.
 */
function readAppliedRefLocal(dest: string): string | undefined {
  const p = path.join(dest, APPLIED_MARKER_PATH)
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : undefined
}

/**
 * Read the pinned `bundle.ref` from the first settings file that exists.
 * Returns undefined when no settings file is found or it has no `bundle.ref`.
 * Mirrors the fetcher's `readBundleRef` so `fetchBundle` can compare without
 * importing the fetcher module.
 */
function readPinnedRef(dest: string): string | undefined {
  for (let i = 0, { length } = SETTINGS_CANDIDATES_LOCAL; i < length; i += 1) {
    const p = path.join(dest, SETTINGS_CANDIDATES_LOCAL[i]!)
    if (!existsSync(p)) {
      continue
    }
    try {
      const json = JSON.parse(readFileSync(p, 'utf8')) as {
        bundle?: { ref?: string | undefined } | undefined
      }
      return json.bundle?.ref
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Step 3: reconcile install so the now-present workspace packages link in.
 */
export function reconcileInstall(): boolean {
  // --ignore-scripts keeps this pass from re-entering `prepare` (a loop); fleet
  // packages have no build step, so skipping lifecycle scripts loses nothing.
  return tryRun('pnpm', ['install', '--ignore-scripts'], {
    ...process.env,
    NO_UPDATE_NOTIFIER: '1',
  })
}

/**
 * Step 2: repair `pnpm-workspace.yaml` `packages:` to list the fleet dirs.
 */
export function repairWorkspacePackages(): void {
  const wsPath = path.join(REPO_ROOT, 'pnpm-workspace.yaml')
  if (!existsSync(wsPath)) {
    log('no pnpm-workspace.yaml — skipping workspace repair')
    return
  }
  const before = readFileSync(wsPath, 'utf8')
  const after = ensureWorkspacePackages(before, FLEET_WORKSPACE_PACKAGES)
  if (after !== before) {
    writeFileSync(wsPath, after)
    log('repaired pnpm-workspace.yaml packages: (added missing fleet dirs)')
  }
}

// The dep-0 doctor lives at <repo-root>/scripts/repo/bootstrap/ (three levels
// deep), so walk up to the nearest package.json ancestor rather than assuming a
// fixed depth — the same repo-root rule as scripts/fleet/paths.mts
// resolveRepoRoot, kept dep-0 (node: builtins only). `fleet.mjs` sits beside
// this file, so HERE (not REPO_ROOT) is used to locate it.
export function resolveRepoRoot(startDir: string): string {
  let cur = startDir
  const { root } = path.parse(cur)
  while (cur && cur !== root) {
    if (existsSync(path.join(cur, 'package.json'))) {
      return cur
    }
    const parent = path.dirname(cur)
    if (parent === cur) {
      break
    }
    cur = parent
  }
  return path.resolve(startDir, '..', '..', '..')
}

/**
 * Run the doctor end-to-end. Returns the intended exit code (0 = healthy / all
 * repairs applied; 1 = the reconcile install failed).
 */
export async function runPrepare(): Promise<number> {
  fetchBundle()
  repairWorkspacePackages()
  if (!reconcileInstall()) {
    log('reconcile `pnpm install --ignore-scripts` failed')
    return 1
  }
  await maybeNotifyUpdate()
  return 0
}

/**
 * Run a command (stdio inherited) from the repo root. Returns true on exit 0,
 * false on any failure — the doctor logs + continues rather than aborting the
 * whole `prepare` on a best-effort step.
 */
export function tryRun(
  cmd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv | undefined,
): boolean {
  try {
    execFileSync(cmd, args as string[], {
      cwd: REPO_ROOT,
      env: env ?? process.env,
      stdio: 'inherit',
    })
    return true
  } catch {
    return false
  }
}

// Realpath both sides: Node resolves the REAL path for `import.meta.url`
// while `process.argv[1]` keeps the path as invoked, so a bare URL equality
// silently skips the CLI body under a symlinked invocation.
if (isMainModule()) {
  // Dep-0 ESM CLI run via node, never CJS-bundled.
  // oxlint-disable-next-line socket/no-top-level-await -- dep-0 ESM CLI run
  process.exitCode = await runPrepare()
}
