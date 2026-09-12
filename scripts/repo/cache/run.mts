import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { getEnvValue } from '@socketsecurity/lib-stable/env/rewire'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

import { isMainModule } from '../../fleet/process/is-main-module.mts'
import { getCacheArgs } from './cli.mts'
import { runMain } from '../../fleet/process/run-main.mts'
import type { ScriptMeta } from '../../fleet/process/run-main.mts'
import { auditGemmaArchive } from './archive.mts'
import { assertGemmaIdentity, probeGemmaBrowser } from './browser.mts'
import { prepareGemmaImage } from './image.mts'
import { uploadGemmaArchive } from './upload.mts'
import {
  cachePaths,
  exportGemmaCache,
  initializeCacheProfile,
  verifyCacheManifest,
} from './util.mts'

export interface DockerProbeConfig {
  browser: string
  cpuOverride?: boolean | undefined
  diagnostics?: string | undefined
  image: string
  name: string
  phase: 'provision' | 'verify'
  profile: string
  seccomp: string
  timeoutMs: number
  uid: number
}

export function dockerProbeArguments(config: DockerProbeConfig): string[] {
  const options = { __proto__: null, ...config } as DockerProbeConfig
  if (
    // A local image ID or repository digest fixes the exact verification image.
    !/^(?:[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(
      options.image,
    )
  ) {
    throw new Error(
      'Unpinned verification image. Saw a mutable Docker reference; expected an image ID or digest. Supply the inspected image SHA256.',
    )
  }
  if (!Number.isSafeInteger(options.uid) || options.uid < 1) {
    throw new Error(
      'Verification user is invalid. Saw root or an invalid UID; expected a non-root user. Run verification as your local user.',
    )
  }
  if (options.profile.includes(',') || options.diagnostics?.includes(',')) {
    throw new Error(
      'Verification profile path is invalid. Saw a comma in a Docker mount path; expected an unambiguous directory. Choose another destination.',
    )
  }
  if (options.phase !== 'provision' && options.phase !== 'verify') {
    throw new Error(
      'Invalid Gemma container phase. Saw an unknown phase; expected provision or verify. Use a supported cache subcommand.',
    )
  }
  const probe = {
    bridge: '/profile/odai-cache.html',
    browser: options.browser,
    cpuOverride: options.cpuOverride,
    offline: options.phase === 'verify',
    profile: '/profile',
    timeoutMs: options.timeoutMs,
    ...(options.diagnostics
      ? { diagnosticRoot: '/private', imageDigest: options.image }
      : {}),
  }
  return [
    'run',
    '--rm',
    '--name',
    options.name,
    '--pull',
    'never',
    '--platform',
    'linux/amd64',
    ...(options.phase === 'verify' ? ['--network', 'none'] : []),
    '--user',
    String(options.uid),
    '--env',
    'HOME=/tmp',
    '--shm-size',
    '2g',
    '--security-opt',
    `seccomp=${path.resolve(options.seccomp)}`,
    '--mount',
    `type=bind,src=${path.resolve(options.profile)},dst=/profile`,
    ...(options.diagnostics
      ? [
          '--env',
          'BREAKPAD_DUMP_LOCATION=/private/crashes',
          '--mount',
          `type=bind,src=${path.resolve(options.diagnostics)},dst=/private`,
        ]
      : []),
    options.image,
    'node',
    '--input-type=module',
    '--eval',
    options.diagnostics
      ? 'const { probeGemmaWithDiagnostics } = await import("/opt/odai-cache/browser.mts"); const result = await probeGemmaWithDiagnostics(JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify(result));'
      : 'const { probeGemmaBrowser } = await import("/opt/odai-cache/browser.mts"); const result = await probeGemmaBrowser(JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify(result));',
    JSON.stringify(probe),
  ]
}

function validateBrowserReceipt(data: unknown, phase: 'provision' | 'verify') {
  assertLinuxReceipt(data)
  if (
    typeof data !== 'object' ||
    data === null ||
    !('model' in data) ||
    data.model !== 'gemma4' ||
    !('offline' in data) ||
    data.offline !== (phase === 'verify') ||
    !('sandbox' in data) ||
    data.sandbox !== true ||
    !('response' in data) ||
    typeof data.response !== 'string'
  ) {
    throw new Error(
      'Invalid offline verification receipt. Saw missing model, network or sandbox evidence; expected verified Gemma inference. Rebuild the pinned verification image and retry.',
    )
  }
  assertGemmaIdentity(data.response)
  return data
}

function assertLinuxReceipt(data: unknown): void {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('platform' in data) ||
    data.platform !== 'linux' ||
    !('architecture' in data) ||
    data.architecture !== 'x64'
  ) {
    throw new Error(
      'Unexpected Gemma verification platform. Saw missing or different platform evidence; expected Linux x64. Rebuild and run the pinned Linux image.',
    )
  }
}

export function validateOfflineReceipt(data: unknown) {
  return validateBrowserReceipt(data, 'verify')
}

async function runDockerProbe(config: DockerProbeConfig) {
  const options = { __proto__: null, ...config } as DockerProbeConfig
  const args = dockerProbeArguments(options)
  if (options.diagnostics) {
    await fs.mkdir(path.resolve(options.diagnostics), { mode: 0o700 })
  }
  try {
    const result = await spawn('docker', args, {
      stdioString: true,
      throws: false,
      timeout: options.timeoutMs + 45_000,
    })
    if (result.code !== 0) {
      throw new Error(
        options.diagnostics
          ? `Gemma ${options.phase} failed in Docker. Saw exit ${result.code}; expected a real model response. Inspect diagnostics at ${path.resolve(options.diagnostics)}.`
          : `Gemma ${options.phase} failed in Docker. Saw exit ${result.code}; expected a real model response. Inspect the container error: ${result.stderr}`,
      )
    }
    const data: unknown = JSON.parse(result.stdout)
    return {
      __proto__: null,
      exitCode: 0,
      data: validateBrowserReceipt(data, options.phase),
    }
  } finally {
    await spawn('docker', ['container', 'rm', '--force', options.name], {
      stdioString: true,
      timeout: 10_000,
    }).catch(() => {})
  }
}

function requiredOption(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Missing ${name} in odai cache command. Saw no value; expected ${name}. Supply ${name} and retry.`,
    )
  }
  return value
}

function cacheTimeout(value: string | undefined): number {
  const timeoutMs = Number(value)
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 1_800_000
  ) {
    throw new Error(
      'Invalid odai timeout. Saw an out-of-range duration; expected 1000 through 1800000 milliseconds. Supply a bounded --timeout.',
    )
  }
  return timeoutMs
}

function parseCacheArguments(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      archive: { type: 'string' },
      'base-image': { type: 'string' },
      browser: { type: 'string' },
      'browser-pin': { type: 'string' },
      builder: { type: 'string' },
      'cpu-override': { type: 'boolean' },
      destination: { type: 'string' },
      diagnostics: { type: 'string' },
      image: { type: 'string' },
      profile: { type: 'string' },
      'release-tag': { type: 'string' },
      seccomp: { type: 'string' },
      timeout: { type: 'string', default: '600000' },
    },
    strict: true,
  })
  const command = positionals[0]
  if (
    positionals.length !== 1 ||
    ![
      'audit-archive',
      'export',
      'prepare-image',
      'provision',
      'upload',
      'verify',
    ].includes(command ?? '')
  ) {
    throw new Error(
      'Unknown odai cache command. Saw an invalid subcommand; expected audit-archive, prepare-image, provision, export, upload, or verify. Use --help for arguments.',
    )
  }
  return { __proto__: null, command, values }
}

export async function main(argv: string[]) {
  const { command, values } = parseCacheArguments(argv)
  if (command === 'audit-archive') {
    const data = await auditGemmaArchive(
      requiredOption(values.archive, '--archive'),
    )
    return { __proto__: null, exitCode: 0, data }
  }
  if (command === 'upload') {
    const data = await uploadGemmaArchive(
      requiredOption(values.archive, '--archive'),
      requiredOption(values['release-tag'], '--release-tag'),
    )
    return { __proto__: null, exitCode: 0, data }
  }
  if (command === 'prepare-image') {
    const data = await prepareGemmaImage({
      baseImage: requiredOption(values['base-image'], '--base-image'),
      browserPinFile: values['browser-pin'],
      builder: values.builder,
      directory: requiredOption(values.destination, '--destination'),
    })
    return { __proto__: null, exitCode: 0, data }
  }
  const profile = path.resolve(requiredOption(values.profile, '--profile'))
  const timeoutMs = cacheTimeout(values.timeout)
  if (command === 'export') {
    const data = await exportGemmaCache(
      profile,
      path.resolve(requiredOption(values.destination, '--destination')),
    )
    return { __proto__: null, exitCode: 0, data }
  }
  const browser = requiredOption(
    values.browser ??
      (values.image
        ? '/usr/bin/google-chrome-beta'
        : getEnvValue('ODAI_CHROME')),
    '--browser',
  )
  if (command === 'provision') {
    await initializeCacheProfile(profile)
    if (values.image) {
      return await runDockerProbe({
        browser,
        cpuOverride: values['cpu-override'],
        diagnostics: values.diagnostics,
        image: values.image,
        name: `odai-cache-${crypto.randomUUID()}`,
        phase: 'provision',
        profile,
        seccomp: requiredOption(values.seccomp, '--seccomp'),
        timeoutMs,
        uid: process.getuid?.() ?? 1000,
      })
    }
    const data = await probeGemmaBrowser({
      bridge: cachePaths(profile).bridge,
      browser,
      cpuOverride: values['cpu-override'],
      offline: false,
      profile,
      timeoutMs,
    })
    return { __proto__: null, exitCode: 0, data }
  }
  await verifyCacheManifest(profile)
  const destination = path.resolve(
    requiredOption(values.destination, '--destination'),
  )
  const name = `odai-cache-${crypto.randomUUID()}`
  const config: DockerProbeConfig = {
    browser,
    cpuOverride: values['cpu-override'],
    diagnostics: values.diagnostics,
    image: requiredOption(values.image, '--image'),
    name,
    phase: 'verify',
    profile: destination,
    seccomp: requiredOption(values.seccomp, '--seccomp'),
    timeoutMs,
    uid: process.getuid?.() ?? 1000,
  }
  await exportGemmaCache(profile, destination)
  return await runDockerProbe(config)
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'provisions Gemma, exports hashed model files, and verifies a copied cache without networking',
  help: 'Usage: pnpm run ai:odai:cache <audit-archive|prepare-image|provision|export|upload|verify> [options]\n--archive <path> Gzip tar archive to audit or upload\n--release-tag <tag> Existing draft release for upload\n--base-image <digest> Pinned Linux x64 Node image for prepare-image\n--builder <name> Local Docker builder for prepare-image\n--browser-pin <file> Verified Chrome package descriptor for an isolated comparison; does not change fleet pins\n--profile <directory> Dedicated Gemma profile\n--browser <path> Chrome Beta executable; defaults to the image binary or ODAI_CHROME\n--cpu-override Force Chrome CPU inference and permit provisioning below the core and RAM minimums\n--destination <new-directory> Image context, export or verification copy\n--diagnostics <new-directory> Retain private crash reports, native logs and resource context\n--image <digest> Prepared Docker image with /opt/odai-cache/browser.mts and playwright-core\n--seccomp <path> Reviewed Chrome sandbox seccomp profile\n--timeout <milliseconds> Bounded model startup, default 600000\nProvision permits component downloads and requires 22 GiB free disk. Without --cpu-override, Linux requires 4 cores and 15000 MiB RAM. Verify uses Docker --network none. Export excludes personal browser data.\n--json Emit a single structured result',
  json: 'result',
}

if (isMainModule(import.meta.url)) {
  runMain(() => main(getCacheArgs()), SCRIPT_META)
}
