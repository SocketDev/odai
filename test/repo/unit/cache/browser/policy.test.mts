import os from 'node:os'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  assertBrowserSandboxArguments,
  cacheBrowserLaunchOptions,
} from '../../../../../scripts/repo/cache/browser/policy.mts'

const config = {
  executablePath: '/fixture/chrome',
  network: 'provision' as const,
  profileDir: '/fixture/cache-profile',
  timeoutMs: 60_000,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cacheBrowserLaunchOptions', () => {
  test('caps provisioned launches and allows browser network defaults to run', () => {
    const options = cacheBrowserLaunchOptions(config)
    expect(options).toMatchObject({
      executablePath: config.executablePath,
      headless: true,
      ignoreDefaultArgs: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-field-trial-config',
      ],
      timeout: 40_000,
    })
    expect(options.args).toContain('--enable-automation')
  })

  test('keeps offline launches isolated when no interfaces exist', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({})
    const options = cacheBrowserLaunchOptions({
      ...config,
      network: 'offline',
    })
    expect(options.ignoreDefaultArgs).toEqual([])
  })

  test('keeps offline launches isolated when only loopback interfaces exist', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      lo0: [
        {
          address: '127.0.0.1',
          cidr: '127.0.0.1/8',
          family: 'IPv4',
          internal: true,
          mac: '00:00:00:00:00:00',
          netmask: '255.0.0.0',
        },
      ],
    })
    const options = cacheBrowserLaunchOptions({
      ...config,
      network: 'offline',
    })
    expect(options.ignoreDefaultArgs).toEqual([])
  })

  test('rejects offline launches when an outward IPv4 interface exists', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      ethernet: [
        {
          address: '192.0.2.1',
          cidr: '192.0.2.1/24',
          family: 'IPv4',
          internal: false,
          mac: '00:00:00:00:00:00',
          netmask: '255.255.255.0',
        },
      ],
    })
    expect(() =>
      cacheBrowserLaunchOptions({ ...config, network: 'offline' }),
    ).toThrow()
  })

  test('rejects offline launches when an outward interface exists', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      en0: [
        {
          address: '2001:db8::1',
          cidr: '2001:db8::1/64',
          family: 'IPv6',
          internal: false,
          mac: '00:00:00:00:00:00',
          netmask: 'ffff:ffff:ffff:ffff::',
          scopeid: 0,
        },
      ],
    })
    expect(() =>
      cacheBrowserLaunchOptions({ ...config, network: 'offline' }),
    ).toThrow()
  })

  test('rejects invalid paths, deadlines, and network modes', () => {
    expect(() =>
      cacheBrowserLaunchOptions({ ...config, executablePath: 'chrome' }),
    ).toThrow()
    expect(() =>
      cacheBrowserLaunchOptions({ ...config, profileDir: 'relative/profile' }),
    ).toThrow()
    expect(() =>
      cacheBrowserLaunchOptions({ ...config, timeoutMs: 0 }),
    ).toThrow()
    expect(() =>
      cacheBrowserLaunchOptions({ ...config, timeoutMs: Number.NaN }),
    ).toThrow()
    expect(() =>
      cacheBrowserLaunchOptions({ ...config, network: 'tunnel' as never }),
    ).toThrow()
  })
})

describe('assertBrowserSandboxArguments', () => {
  test('allows ordinary browser arguments', () => {
    expect(() =>
      assertBrowserSandboxArguments(['--enable-automation']),
    ).not.toThrow()
  })

  test.each(['--no-sandbox', '--disable-setuid-sandbox'])(
    'rejects sandbox bypass flag %s',
    flag => {
      expect(() => assertBrowserSandboxArguments([flag])).toThrow()
    },
  )
})

test('retains networking defaults offline and refuses an outward interface', () => {
  const interfaces = vi.spyOn(os, 'networkInterfaces').mockReturnValue({})
  expect(
    cacheBrowserLaunchOptions({ ...config, network: 'offline' })
      .ignoreDefaultArgs,
  ).toEqual([])
  interfaces.mockReturnValue({
    ethernet: [
      {
        address: '192.0.2.1',
        cidr: '192.0.2.1/24',
        family: 'IPv4',
        internal: false,
        mac: '00:00:00:00:00:00',
        netmask: '255.255.255.0',
      },
    ],
  })
  expect(() =>
    cacheBrowserLaunchOptions({ ...config, network: 'offline' }),
  ).toThrow()
})

test('rejects relative executable paths and invalid deadlines', () => {
  expect(() =>
    cacheBrowserLaunchOptions({ ...config, executablePath: 'chrome' }),
  ).toThrow()
  expect(() => cacheBrowserLaunchOptions({ ...config, timeoutMs: 0 })).toThrow()
})

const options = {
  executablePath: '/example/chrome-beta',
  network: 'provision' as const,
  profileDir: '/example/profile',
  timeoutMs: 60_000,
}

test('routes native errors to an explicit absolute log path without changing sandbox flags', () => {
  const result = cacheBrowserLaunchOptions({
    ...options,
    logFile: '/example/private/chrome.log',
  })
  expect(result.args).toContain('--enable-logging')
  expect(result.args).toContain('--log-file=/example/private/chrome.log')
  expect(() => assertBrowserSandboxArguments(result.args)).not.toThrow()
  expect(() =>
    cacheBrowserLaunchOptions({ ...options, logFile: 'chrome.log' }),
  ).toThrow()
  expect(cacheBrowserLaunchOptions(options).args).not.toContain(
    '--enable-logging',
  )
})

test.each(['offline', 'provision'] as const)(
  'enables CPU inference only on explicit request for %s',
  network => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({})
    const ordinary = cacheBrowserLaunchOptions({ ...options, network })
    const cpu = cacheBrowserLaunchOptions({
      ...options,
      cpuOverride: true,
      network,
    })
    expect(ordinary.args).not.toContain(
      '--enable-features=OnDeviceModelForceCpuBackend',
    )
    expect(ordinary.args).not.toContain(
      '--optimization-guide-performance-class=8',
    )
    expect(cpu.args).toContain('--enable-features=OnDeviceModelForceCpuBackend')
    expect(cpu.args).toContain('--optimization-guide-performance-class=8')
    expect(cpu.timeout).toBe(ordinary.timeout)
    expect(cpu.ignoreDefaultArgs).toEqual(ordinary.ignoreDefaultArgs)
    expect(() => assertBrowserSandboxArguments(cpu.args)).not.toThrow()
  },
)

test('preserves offline network isolation when CPU inference is requested', () => {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    eth0: [
      {
        address: '192.0.2.1',
        cidr: '192.0.2.1/24',
        family: 'IPv4',
        internal: false,
        mac: '00:00:00:00:00:00',
        netmask: '255.255.255.0',
      },
    ],
  })
  expect(() =>
    cacheBrowserLaunchOptions({
      ...options,
      cpuOverride: true,
      network: 'offline',
    }),
  ).toThrow()
})
