import fs from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { isObject } from '@socketsecurity/lib-stable/objects/predicates'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'
import { integrityValue } from '../../fleet/external-tools/integrity.mts'
import { REPO_ROOT } from '../../fleet/paths.mts'

export interface GemmaImageConfig {
  baseImage: string
  browserPinFile?: string | undefined
  builder?: string | undefined
  directory: string
  toolsManifest?: string | undefined
}

function imageIntegrity(value: unknown) {
  const provenance = isObject(value) ? value : {}
  const sri = typeof value === 'string' ? value : provenance['value']
  if (typeof sri !== 'string' || !sri) {
    throw new Error(
      'Invalid setup tool integrity. Saw missing SRI; expected a pinned digest. Refresh the canonical tool pin.',
    )
  }
  const args: string[] = []
  for (const key of ['src', 'date']) {
    if (typeof provenance[key] === 'string') {
      args.push(`--${key}`, provenance[key])
    }
  }
  return { __proto__: null, integrity: integrityValue(sri)!, args }
}

function imageTool(manifest: unknown, name: string) {
  const tools =
    isObject(manifest) && isObject(manifest['tools']) ? manifest['tools'] : {}
  const tool = tools[name]
  const platform =
    isObject(tool) && isObject(tool['platforms'])
      ? tool['platforms']['linux-x64']
      : undefined
  if (
    !isObject(tool) ||
    typeof tool['version'] !== 'string' ||
    !isObject(platform) ||
    typeof platform['asset'] !== 'string'
  ) {
    throw new Error(
      `Invalid ${name} pin in setup tools. Saw missing Linux x64 metadata; expected version, URL and integrity. Refresh the canonical tool pin.`,
    )
  }
  const { args, integrity } = imageIntegrity(platform['integrity'])
  return {
    __proto__: null,
    version: tool['version'],
    asset: platform['asset'],
    args,
    integrity,
  }
}

async function imageBrowser(manifest: unknown, pinFile?: string | undefined) {
  let name = 'google-chrome-beta'
  let source = manifest
  if (pinFile) {
    const descriptor: unknown = JSON.parse(await fs.readFile(pinFile, 'utf8'))
    if (
      !isObject(descriptor) ||
      !['google-chrome-beta', 'google-chrome-stable'].includes(
        String(descriptor['name']),
      ) ||
      typeof descriptor['version'] !== 'string' ||
      !/^\d+\.\d+\.\d+\.\d+(?:-\d+)?$/.test(descriptor['version'])
    ) {
      throw new Error(
        'Invalid diagnostic browser pin. Expected a complete Chrome Beta or Stable Linux package descriptor. Supply a verified browser pin file.',
      )
    }
    name = String(descriptor['name'])
    source = { tools: { [name]: descriptor } }
  }
  const tool = imageTool(source, name)
  return {
    __proto__: null,
    version: tool.version,
    asset: tool.asset,
    args: tool.args,
    integrity: tool.integrity,
    browserPath: `/usr/bin/${name}`,
    moduleRoot:
      name === 'google-chrome-stable'
        ? '/opt/google/chrome'
        : '/opt/google/chrome-beta',
  }
}

export async function buildGemmaBrowserBundle(): Promise<string> {
  const { rolldown } = await import('rolldown')
  const bundle = await rolldown({
    input: fileURLToPath(new URL('./browser.mts', import.meta.url)),
    platform: 'node',
    external: specifier =>
      isBuiltin(specifier) || specifier === 'playwright-core',
  })
  try {
    const result = await bundle.generate({
      format: 'esm',
      entryFileNames: 'browser.generated.mjs',
      sourcemap: false,
    })
    const { 0: chunk } = result.output
    if (
      result.output.length !== 1 ||
      chunk?.type !== 'chunk' ||
      [...chunk.imports, ...chunk.dynamicImports].some(
        specifier => !isBuiltin(specifier) && specifier !== 'playwright-core',
      )
    ) {
      throw new Error(
        'Gemma browser bundle is incomplete. Where: image context. Saw external files; wanted one ESM chunk and playwright-core. Fix: bundle all other runtime dependencies.',
      )
    }
    return chunk.code
  } finally {
    await bundle.close()
  }
}

export async function prepareGemmaImage(config: GemmaImageConfig) {
  const opts = { __proto__: null, ...config } as typeof config
  if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(opts.baseImage)) {
    throw new Error(
      'Invalid Gemma base image. Saw a mutable or malformed reference; expected a named image with SHA256 digest. Supply a pinned Linux x64 Node image.',
    )
  }
  const directory = path.resolve(opts.directory)
  const manifest: unknown = JSON.parse(
    await fs.readFile(
      opts.toolsManifest ??
        path.join(REPO_ROOT, '.config/repo/external-tools.json'),
      'utf8',
    ),
  )
  const chrome = await imageBrowser(manifest, opts.browserPinFile)
  const seccomp = imageTool(manifest, 'playwright-seccomp')
  const decoder = [
    'binutils',
    'binutils-lib',
    'binutils-sframe',
    'binutils-ctf',
    'binutils-jansson',
  ].map(name => imageTool(manifest, name))
  const require = createRequire(import.meta.url)
  const packageFile = await fs.realpath(
    require.resolve('playwright-core/package.json'),
  )
  const installed: unknown = JSON.parse(await fs.readFile(packageFile, 'utf8'))
  if (!isObject(installed) || installed['version'] !== seccomp.version) {
    throw new Error(
      `Playwright version mismatch at ${packageFile}. Saw an incompatible package; expected ${seccomp.version}. Install the workspace-pinned playwright-core before preparing the image.`,
    )
  }
  let builder = opts.builder
  if (!builder) {
    const result = await spawn('docker', ['context', 'show'], {
      timeout: 10_000,
    })
    builder = result.stdout.trim()
  }
  if (!builder || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(builder)) {
    throw new Error(
      'Invalid Docker builder. Saw an empty or malformed name; expected an explicit builder or current context name. Configure a local Docker context.',
    )
  }
  await fs.mkdir(directory, { mode: 0o700 })
  try {
    const installer = path.join(
      REPO_ROOT,
      '.github/actions/fleet/_shared/install-tool.mjs',
    )
    const chromePath = path.join(directory, 'chrome.deb')
    const seccompPath = path.join(directory, 'seccomp.json')
    for (const [tool, file] of [
      [chrome, chromePath],
      [seccomp, seccompPath],
      ...decoder.map(
        (decoderTool, index) =>
          [decoderTool, path.join(directory, `decoder-${index}.deb`)] as const,
      ),
    ] as const) {
      await spawn(
        process.execPath,
        [
          installer,
          tool.asset,
          tool.integrity,
          directory,
          path.basename(file),
          ...tool.args,
        ],
        { timeout: 300_000 },
      )
    }
    await fs.writeFile(
      path.join(directory, 'browser-path'),
      chrome.browserPath + '\n',
    )
    await fs.writeFile(
      path.join(directory, 'chrome-version'),
      chrome.version.replace(/-\d+$/, '') + '\n',
    )
    await fs.writeFile(
      path.join(directory, 'decoder-metadata.json'),
      JSON.stringify(
        decoder.map(tool => ({
          __proto__: null,
          version: tool.version,
          integrity: tool.integrity,
        })),
      ),
    )
    await fs.writeFile(
      path.join(directory, 'browser.generated.mjs'),
      await buildGemmaBrowserBundle(),
    )
    await fs.cp(
      path.dirname(packageFile),
      path.join(directory, 'node_modules/playwright-core'),
      { recursive: true, dereference: true },
    )
    await fs.writeFile(
      path.join(directory, '.dockerignore'),
      '*\n!Dockerfile\n!chrome.deb\n!decoder-*.deb\n!chrome-version\n!browser-path\n!decoder-metadata.json\n!browser.generated.mjs\n!node_modules/\n!node_modules/**\n',
    )
    await fs.writeFile(
      path.join(directory, 'Dockerfile'),
      `FROM ${opts.baseImage}
USER root
COPY chrome.deb /tmp/chrome.deb
RUN apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb && rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*
COPY decoder-*.deb /tmp/decoder-debs/
RUN mkdir -p /opt/odai-cache/decoder && for file in /tmp/decoder-debs/*.deb; do dpkg-deb -x "$file" /opt/odai-cache/decoder; done && rm -rf /tmp/decoder-debs && LD_LIBRARY_PATH=/opt/odai-cache/decoder/usr/lib/x86_64-linux-gnu /opt/odai-cache/decoder/usr/bin/x86_64-linux-gnu-objdump --version
COPY chrome-version browser-path decoder-metadata.json /opt/odai-cache/
COPY browser.generated.mjs /opt/odai-cache/browser.mts
COPY node_modules /opt/odai-cache/node_modules
RUN node --input-type=module -e "import { buildGemmaModuleInventory } from '/opt/odai-cache/browser.mts'; await buildGemmaModuleInventory({roots: ['${chrome.moduleRoot}', '/usr/lib/x86_64-linux-gnu']})" && chmod 644 /opt/odai-cache/native-modules.json
USER node
`,
    )
    const imageFile = path.join(directory, 'image-id')
    await spawn(
      'docker',
      [
        'buildx',
        'build',
        '--builder',
        builder,
        '--platform',
        'linux/amd64',
        '--load',
        '--iidfile',
        imageFile,
        directory,
      ],
      { timeout: 1_800_000 },
    )
    const imageId = (await fs.readFile(imageFile, 'utf8')).trim()
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
      throw new Error(
        `Invalid image ID at ${imageFile}. Saw a mutable or missing image identifier; expected SHA256. Inspect the Docker build result.`,
      )
    }
    return {
      __proto__: null,
      imageId,
      seccompPath,
      browserPath: chrome.browserPath,
    }
  } catch (error) {
    await safeDelete(directory)
    throw error
  }
}
