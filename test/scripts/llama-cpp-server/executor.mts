/**
 * @file Run staging for the llama.cpp server conformance runner: bring odai's
 *   shim up on a loopback port, drive the upstream pytest suite against it,
 *   and read the results back. The upstream harness has a native
 *   external-server mode (`DEBUG_EXTERNAL`), so it never spawns a binary — it
 *   talks to whatever answers on `PORT`, which is odai. Python arrives through
 *   `uv run --with <pkg>==<exact>`: exact pins, nothing installed globally.
 */

import { readFileSync } from 'node:fs'

import { spawn } from '@socketsecurity/lib/process/spawn/child'

import { startShimServer } from '../../../src/shim/server.mts'
import type { BackendName } from '../../../src/backends/types.mts'
import type { StagedSuite } from './harness.mts'
import type { TestCase } from './types.mts'

/**
 * The python packages the upstream suite imports, pinned exactly. `wget` and
 * `aiohttp` are imported by `utils.py` itself, so they are needed even though
 * the copied tests never call them.
 */
export const PYTHON_PINS: readonly string[] = [
  'aiohttp==3.9.5',
  'openai==2.14.0',
  'pytest==8.3.5',
  'requests==2.32.3',
  'wget==3.2',
]

const PYTHON_VERSION = '3.12'

const LOOPBACK_NO_PROXY = '127.0.0.1,::1,localhost'

export interface RunOptions {
  backendName?: BackendName | undefined
  log?: ((line: string) => void) | undefined
  staged: StagedSuite
}

export interface RunResult {
  cases: TestCase[]
  /**
   * Pytest's own exit code, kept for diagnostics. The verdict comes from the
   * classifier, not from this.
   */
  pytestExitCode: number
}

/**
 * Turn pytest's JUnit XML into cases keyed the way the allowlist spells them.
 * JUnit is well-formed and shallow here, so the reader walks `<testcase …>`
 * elements with a regex rather than pulling in an XML parser.
 */
export function parseJUnitReport(xml: string): TestCase[] {
  const cases: TestCase[] = []
  // Each `<testcase classname="…" name="…"` element, then either a
  // self-closing `/>` (a pass) or a body up to `</testcase>` carrying a
  // `<failure`, `<error`, or `<skipped` child.
  const caseRe =
    /<testcase\b[^>]*classname="([^"]*)"[^>]*name="([^"]*)"[^>]*?(>([\s\S]*?)<\/testcase>|\/>)/g
  for (;;) {
    const match = caseRe.exec(xml)
    if (match === null) {
      break
    }
    const [, classname = '', name = '', selfClosing = '', body = ''] = match
    const file = `${classname.replaceAll('.', '/')}.py`
    let outcome: TestCase['outcome'] = 'pass'
    let detail = ''
    if (selfClosing !== '/>') {
      if (body.includes('<skipped')) {
        outcome = 'skip'
      } else if (body.includes('<failure') || body.includes('<error')) {
        outcome = 'fail'
        detail = firstMessage(body)
      }
    }
    cases.push({ detail, id: `${file}::${decodeXml(name)}`, outcome })
  }
  return cases
}

/**
 * Read the `message="…"` of a failure or error child, decoded and clipped.
 */
export function firstMessage(body: string): string {
  const match = /<(?:error|failure)\b[^>]*message="([^"]*)"/.exec(body)
  return match === null ? '' : decodeXml(match[1]!).slice(0, 200)
}

export function decodeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#10;', ' ')
    .replaceAll('&amp;', '&')
}

/**
 * Env for the pytest process with every proxy variable dropped and loopback
 * named in `no_proxy`. Python's `requests` and the `openai` client honor the
 * ambient proxy even for 127.0.0.1, so under Socket Firewall every request to
 * the shim came back as the firewall's own HTML page (an HTTP 405 to the test's
 * eyes) instead of reaching odai.
 */
export function loopbackDirectEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env }
  const proxyVars = [
    'ALL_PROXY',
    'all_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
  ]
  for (let i = 0, { length } = proxyVars; i < length; i += 1) {
    delete next[proxyVars[i]!]
  }
  next['NO_PROXY'] = LOOPBACK_NO_PROXY
  next['no_proxy'] = LOOPBACK_NO_PROXY
  return next
}

/**
 * Start odai's shim, run the staged suite against it, and stop the shim. The
 * shim's port is OS-assigned and handed to pytest through `PORT`, so two runs
 * never collide.
 */
export async function runSuite(options: RunOptions): Promise<RunResult> {
  const opts = { __proto__: null, ...options } as RunOptions
  const log = opts.log ?? (() => undefined)
  const { staged } = opts
  const handle = await startShimServer(
    opts.backendName === undefined ? {} : { backendName: opts.backendName },
  )
  log(`shim listening at ${handle.url} over backend "${handle.backendName}"`)
  const args = ['run', '--python', PYTHON_VERSION]
  for (let i = 0, { length } = PYTHON_PINS; i < length; i += 1) {
    args.push('--with', PYTHON_PINS[i]!)
  }
  args.push(
    'pytest',
    ...staged.testFiles,
    '-p',
    'no:cacheprovider',
    '-q',
    '--tb=no',
    '-m',
    'not slow',
    `--junit-xml=${staged.reportPath}`,
  )
  let pytestExitCode = 0
  try {
    const result = await spawn('uv', args, {
      cwd: staged.scratchDir,
      env: {
        ...loopbackDirectEnv(process.env),
        DEBUG_EXTERNAL: '1',
        LLAMA_CACHE: staged.scratchDir,
        PORT: String(handle.port),
      },
      stdio: 'inherit',
    })
    pytestExitCode = result.code ?? 0
  } catch (error) {
    // pytest exits non-zero whenever a test failed, which is the normal case
    // here: the verdict belongs to the classifier, so a non-zero exit is data.
    pytestExitCode = (error as { code?: number | undefined }).code ?? 1
  } finally {
    await handle.close()
  }
  let cases: TestCase[] = []
  try {
    cases = parseJUnitReport(readFileSync(staged.reportPath, 'utf8'))
  } catch {
    throw new Error(
      `pytest wrote no JUnit report at ${staged.reportPath} (exit ` +
        `${pytestExitCode}). The suite did not run, so there is no result to ` +
        'classify — check that `uv` is installed and that the pinned python ' +
        'packages resolved.',
    )
  }
  return { cases, pytestExitCode }
}
