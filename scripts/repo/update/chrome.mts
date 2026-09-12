import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { debugNs } from '@socketsecurity/lib-stable/debug/output'
import { getEnvValue } from '@socketsecurity/lib-stable/env/rewire'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { isObject } from '@socketsecurity/lib-stable/objects/predicates'
import { checksumsMatch } from '../../../.github/actions/fleet/_shared/verify-integrity-provenance.mjs'
import { prepareGemmaImage } from '../cache/image.mts'
import { main as runCache, validateOfflineReceipt } from '../cache/run.mts'
import { verifyCacheManifest } from '../cache/util.mts'
import { integrityValue } from '../../fleet/external-tools/integrity.mts'
import { FLEET_CACHE_DIR } from '../../fleet/paths.mts'
import { isMainModule } from '../../fleet/process/is-main-module.mts'
import { runMain } from '../../fleet/process/run-main.mts'
import { getCacheArgs as getScriptArgs } from '../cache/cli.mts'
import type { ScriptMeta } from '../../fleet/process/run-main.mts'

export interface ChromeTool {
  origin: 'node-dist'
  version: string
  platforms: {
    'linux-x64': {
      asset: string
      integrity: string | { value: string; src: string; date: string }
    }
  }
}

function chromeAssetMatches(
  name: string,
  version: string,
  asset: string,
): boolean {
  const packageVersion = version.includes('-') ? version : `${version}-1`
  return (
    asset ===
    `https://dl.google.com/linux/chrome/deb/pool/main/g/${name}/${name}_${packageVersion}_amd64.deb`
  )
}

function validChromeIntegrity(value: string): boolean {
  // SHA-256/384/512 prefix followed by its encoded digest.
  const match = /^sha(256|384|512)-(.+)$/.exec(value)
  if (!match) {
    return false
  }
  const size = Number(match[1]) / 8
  const digest = match[2]!
  const bytes = Buffer.from(
    digest,
    digest.length === size * 2 && /^[a-f0-9]+$/i.test(digest)
      ? 'hex'
      : 'base64',
  )
  return bytes.length === size && checksumsMatch(value, bytes.toString('hex'))
}

function chromeCandidateIntegrity(pin: unknown) {
  if (typeof pin === 'string') {
    return pin
  }
  if (
    isObject(pin) &&
    typeof pin['value'] === 'string' &&
    typeof pin['src'] === 'string' &&
    typeof pin['date'] === 'string'
  ) {
    return {
      __proto__: null,
      value: pin['value'],
      src: pin['src'],
      date: pin['date'],
    }
  }
  return undefined
}

function parseChromeCandidate(value: unknown) {
  const candidate = isObject(value) ? value : {}
  const platforms = isObject(candidate['platforms'])
    ? candidate['platforms']
    : {}
  const platform = isObject(platforms['linux-x64'])
    ? platforms['linux-x64']
    : {}
  const integrity = chromeCandidateIntegrity(platform['integrity'])
  const name = candidate['name']
  const version = candidate['version']
  const asset = platform['asset']
  const supported = ['google-chrome-beta', 'google-chrome-stable'].includes(
    String(name),
  )
  if (
    typeof name !== 'string' ||
    !supported ||
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+\.\d+(?:-\d+)?$/.test(version) ||
    (candidate['origin'] !== undefined &&
      candidate['origin'] !== 'node-dist') ||
    typeof asset !== 'string' ||
    !integrity ||
    !validChromeIntegrity(integrityValue(integrity)!) ||
    !chromeAssetMatches(name, version, asset)
  ) {
    throw new Error(
      'Chrome candidate verification has an invalid descriptor. Saw missing or mismatched package, version, asset or integrity; expected one complete official Linux x64 package. Supply its exact Google download URL and verified digest.',
    )
  }
  const tool: ChromeTool = {
    origin: 'node-dist',
    version,
    platforms: { 'linux-x64': { asset, integrity } },
  }
  return { __proto__: null, name, tool }
}

function chromePrerequisites() {
  const profile = getEnvValue('ODAI_CACHE_PROFILE')?.trim()
  const baseImage = getEnvValue('ODAI_CACHE_BASE_IMAGE')?.trim()
  if (!profile || !path.isAbsolute(profile) || profile.includes(',')) {
    throw new Error(
      'Chrome candidate verification requires ODAI_CACHE_PROFILE. Saw a missing or invalid path; expected an absolute exported Gemma profile path without commas. Export a closed Gemma profile with ai:odai:cache export and set ODAI_CACHE_PROFILE.',
    )
  }
  if (
    !baseImage ||
    !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(baseImage)
  ) {
    throw new Error(
      'Chrome candidate verification requires ODAI_CACHE_BASE_IMAGE. Saw a missing or mutable reference; expected a Linux x64 Node image with a SHA256 digest. Set ODAI_CACHE_BASE_IMAGE to the verified image reference.',
    )
  }
  const diagnosticsRoot =
    getEnvValue('ODAI_CACHE_DIAGNOSTICS')?.trim() ||
    path.join(FLEET_CACHE_DIR, 'ai', 'odai', 'diagnostics')
  if (!path.isAbsolute(diagnosticsRoot) || diagnosticsRoot.includes(',')) {
    throw new Error(
      'Chrome candidate verification has an invalid ODAI_CACHE_DIAGNOSTICS path. Saw a relative path or comma; expected an absolute diagnostic directory. Set a dedicated absolute directory without commas.',
    )
  }
  return {
    __proto__: null,
    profile,
    baseImage,
    diagnosticsRoot,
    builder: getEnvValue('ODAI_CACHE_BUILDER')?.trim() || undefined,
  }
}

async function cleanupChromeScratch(
  directory: string,
  options: { failed?: boolean | undefined } = {},
) {
  const opts = { __proto__: null, ...options } as typeof options
  try {
    await safeDelete(directory)
  } catch (cause) {
    if (!opts.failed) {
      throw new Error(
        `Chrome verification cleanup failed at ${directory}. Saw retained scratch files; expected removal after verification. Remove this owned directory and retry.`,
        { cause },
      )
    }
    debugNs(
      'fleet:update:chrome',
      `Scratch cleanup failed at ${directory}; the primary verification error is retained.`,
    )
  }
}

export async function verifyChromeCandidate(
  name: string,
  tool: ChromeTool,
): Promise<void> {
  const candidate = parseChromeCandidate({ ...tool, name })
  const { profile, baseImage, builder, diagnosticsRoot } = chromePrerequisites()
  try {
    await verifyCacheManifest(profile)
  } catch (cause) {
    throw new Error(
      `Chrome candidate verification rejected ODAI_CACHE_PROFILE at ${profile}. Saw missing or invalid cache hashes; expected a verified Gemma export. Export a fresh closed profile with ai:odai:cache export and retry.`,
      { cause },
    )
  }
  await fs.mkdir(diagnosticsRoot, { recursive: true, mode: 0o700 })
  const diagnostics = await fs.mkdtemp(
    path.join(diagnosticsRoot, `chrome-${candidate.tool.version}-`),
  )
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-verify-'))
  let failed = false
  try {
    const browserPinFile = path.join(directory, 'candidate.json')
    await fs.writeFile(
      browserPinFile,
      JSON.stringify({ name: candidate.name, ...candidate.tool }),
      { flag: 'wx', mode: 0o600 },
    )
    const evidence = {
      name: candidate.name,
      version: candidate.tool.version,
      asset: candidate.tool.platforms['linux-x64'].asset,
      integrity: integrityValue(
        candidate.tool.platforms['linux-x64'].integrity,
      ),
      baseImage,
    }
    await fs.writeFile(
      path.join(diagnostics, 'candidate.json'),
      JSON.stringify(evidence),
      { flag: 'wx', mode: 0o600 },
    )
    const image = await prepareGemmaImage({
      baseImage,
      browserPinFile,
      builder,
      directory: path.join(directory, 'image'),
    })
    await fs.writeFile(
      path.join(diagnostics, 'image.json'),
      JSON.stringify({
        imageId: image.imageId,
        browserPath: image.browserPath,
      }),
      { flag: 'wx', mode: 0o600 },
    )
    const result = await runCache([
      'verify',
      '--profile',
      profile,
      '--destination',
      path.join(directory, 'profile'),
      '--browser',
      image.browserPath,
      '--image',
      image.imageId,
      '--seccomp',
      image.seccompPath,
      '--diagnostics',
      path.join(diagnostics, 'probe'),
      '--cpu-override',
      '--timeout',
      '60000',
    ])
    const receipt = validateOfflineReceipt(result.data)
    const expectedVersion = candidate.tool.version.replace(/-\d+$/, '')
    if (
      result.exitCode !== 0 ||
      !('browserVersion' in receipt) ||
      typeof receipt.browserVersion !== 'string' ||
      ![
        `Chrome/${expectedVersion}`,
        `HeadlessChrome/${expectedVersion}`,
      ].includes(receipt.browserVersion)
    ) {
      throw new Error(
        `Chrome candidate verification failed for ${candidate.name} ${expectedVersion}. Saw a failed run or a different browser version; expected the exact candidate and a successful offline Gemma prompt. Inspect the candidate image and repeat verification before updating its pin.`,
      )
    }
  } catch (cause) {
    failed = true
    throw new Error(
      `Chrome candidate verification failed. Evidence: ${diagnostics}. Saw an unsuccessful candidate build or inference; expected an exact browser and offline Gemma response. Inspect the retained diagnostics, confirm Docker is available, and retry before updating the pin.`,
      { cause },
    )
  } finally {
    await cleanupChromeScratch(directory, { failed })
  }
}

export async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { candidate: { type: 'string' }, json: { type: 'boolean' } },
    strict: true,
    allowPositionals: false,
  })
  if (!values.candidate) {
    throw new Error(
      'Chrome candidate verification requires --candidate. Saw no descriptor path; expected a JSON file with name, version and Linux x64 asset integrity. Supply --candidate <file>.',
    )
  }
  const value: unknown = JSON.parse(await fs.readFile(values.candidate, 'utf8'))
  const { name, tool } = parseChromeCandidate(value)
  await verifyChromeCandidate(name, tool)
  return {
    __proto__: null,
    exitCode: 0,
    data: { name, version: tool.version, verified: true },
  }
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'verifies a Chrome candidate with a sandboxed offline Gemma prompt before its pin changes',
  help: 'Usage: node scripts/repo/update/chrome.mts --candidate <file> [--json]\nRequires ODAI_CACHE_PROFILE and a digest-pinned ODAI_CACHE_BASE_IMAGE. ODAI_CACHE_BUILDER optionally selects the local Docker builder. ODAI_CACHE_DIAGNOSTICS optionally selects the persistent evidence root. The candidate descriptor contains name, version and platforms.linux-x64 asset and integrity. Verification uses a temporary profile and a 60000ms inference deadline.',
  json: 'result',
}

if (isMainModule(import.meta.url)) {
  runMain(() => main(getScriptArgs()), SCRIPT_META)
}
