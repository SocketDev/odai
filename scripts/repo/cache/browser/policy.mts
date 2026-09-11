import os from 'node:os'
import path from 'node:path'

export interface CacheSessionConfig {
  cpuOverride?: boolean | undefined
  executablePath: string
  logFile?: string | undefined
  network: 'offline' | 'provision'
  profileDir: string
  timeoutMs: number
}

export function cacheBrowserLaunchOptions(config: CacheSessionConfig) {
  const options = { __proto__: null, ...config } as CacheSessionConfig
  if (
    !path.isAbsolute(options.executablePath) ||
    !path.isAbsolute(options.profileDir) ||
    (options.logFile !== undefined && !path.isAbsolute(options.logFile)) ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    (options.network !== 'offline' && options.network !== 'provision')
  ) {
    throw new Error(
      'Invalid cache browser configuration. Saw an invalid path, network mode or deadline; expected absolute paths and a positive deadline. Correct the cache configuration.',
    )
  }
  if (
    options.network === 'offline' &&
    Object.values(os.networkInterfaces()).some(addresses =>
      addresses?.some(address => !address.internal),
    )
  ) {
    throw new Error(
      'Cache browser network is not isolated. Saw an outward interface; expected only loopback for offline mode. Run verification in its isolated container.',
    )
  }
  return {
    __proto__: null,
    args: [
      '--enable-automation',
      '--disable-features=DialMediaRouteProvider,GlobalMediaControls,MediaRouter,Translate',
      ...(options.logFile
        ? ['--enable-logging', `--log-file=${options.logFile}`]
        : []),
      ...(options.cpuOverride === true
        ? [
            '--enable-features=OnDeviceModelForceCpuBackend',
            '--optimization-guide-performance-class=8',
          ]
        : []),
    ],
    executablePath: options.executablePath,
    headless: true,
    ignoreDefaultArgs:
      options.network === 'offline'
        ? []
        : [
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-field-trial-config',
          ],
    timeout: Math.min(40_000, options.timeoutMs),
  }
}

export function assertBrowserSandboxArguments(args: readonly string[]): void {
  if (
    args.some(
      argument =>
        argument === '--disable-setuid-sandbox' || argument === '--no-sandbox',
    )
  ) {
    throw new Error(
      'Chrome sandbox is disabled. Saw a sandbox bypass flag; expected sandbox protection. Fix the browser launch configuration.',
    )
  }
}
