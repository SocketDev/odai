import { expect, test } from 'vitest'
import { parseGemmaKernelFaults } from '../../../../scripts/repo/cache/kernel.mts'

// Numeric times follow util-linux tests/expected/dmesg/json.
const INVALID_OPCODE =
  'traps: example-worker[123] trap invalid opcode ip:10 sp:20 error:0 in liboptimization_guide_internal.so[1000+2000]'
const SEGFAULT =
  'example-worker[456]: segfault at 20 ip 10 sp 30 error 4 in chrome[1000+2000] likely on CPU 0 (core 0, socket 0)'
const SECCOMP =
  'audit: type=1326 audit(123456.123:9): auid=1000 uid=1000 gid=1000 ses=1 pid=789 comm="example-worker" exe="/example/private/chrome" sig=31 arch=c000003e syscall=257 compat=0 ip=0x10 code=0x80000000'

function kernelInput(messages: string[], start = 100): string {
  return JSON.stringify({
    dmesg: messages.map((msg, index) => ({ pri: 6, time: start + index, msg })),
  })
}

test('retains only fault categories, approved modules, times and explicit audit numbers', () => {
  const result = parseGemmaKernelFaults(
    kernelInput([INVALID_OPCODE, SEGFAULT, SECCOMP]),
    99,
  )
  expect(result).toEqual({
    status: 'captured',
    attribution: 'host-during-probe',
    events: [
      {
        category: 'invalid-opcode',
        module: 'liboptimization_guide_internal.so',
        timeSeconds: 100,
      },
      { category: 'segfault', module: 'chrome', timeSeconds: 101 },
      {
        category: 'seccomp',
        module: 'chrome',
        timeSeconds: 102,
        signal: 31,
        syscall: 257,
      },
    ],
  })
  const text = JSON.stringify(result)
  for (const privateValue of [
    'example-worker',
    '/example/private',
    '1000+2000',
    'c000003e',
    'pid',
    'ip:',
  ]) {
    expect(text).not.toContain(privateValue)
  }
})

test('compares numeric seconds since boot without rounding to whole seconds', () => {
  const input = JSON.stringify({
    dmesg: [99, 100.125, 100.125001].map(time => ({
      pri: 6,
      time,
      msg: SEGFAULT,
    })),
  })
  expect(parseGemmaKernelFaults(input, 100.125).events).toEqual([
    { category: 'segfault', module: 'chrome', timeSeconds: 100.125001 },
  ])
})

test('does not turn trap error codes into signals or treat signal zero as a kill', () => {
  const result = parseGemmaKernelFaults(
    kernelInput([
      INVALID_OPCODE.replace('error:0', 'error:6'),
      SECCOMP.replace('sig=31', 'sig=0'),
    ]),
    99,
  )
  expect(result.events[0]).not.toHaveProperty('signal')
  expect(result.events[0]).not.toHaveProperty('trap')
  expect(result.events[1]).toMatchObject({ category: 'seccomp', signal: 0 })
})

test.each([
  'ordinary kernel message',
  INVALID_OPCODE.replace(
    'liboptimization_guide_internal.so',
    'private-module.so',
  ),
  SEGFAULT.replace('in chrome[', 'in private-chrome['),
  SEGFAULT.replace('in chrome[', 'in /private/chrome['),
  SECCOMP.replace('/example/private/chrome', '/example/private/chrome-helper'),
  SECCOMP.replace('type=1326', 'type=1701'),
  SECCOMP.replace('sig=31', 'sig=999'),
  SECCOMP.replace('syscall=257', 'syscall=private-value'),
])(
  'discards unknown or malformed event shapes without echoing them',
  message => {
    expect(parseGemmaKernelFaults(kernelInput([message]), 99)).toEqual({
      status: 'captured',
      attribution: 'host-during-probe',
      events: [],
    })
  },
)

test('does not attribute userspace-injected kernel-buffer messages to kernel faults', () => {
  expect(
    parseGemmaKernelFaults(
      JSON.stringify({
        dmesg: [{ pri: 14, time: 100, msg: INVALID_OPCODE }],
      }),
      99,
    ).events,
  ).toEqual([])
})

test.each([
  '',
  '{"dmesg":[',
  'permission denied',
  '{}',
  '{"dmesg":{}}',
  '{"dmesg":[{"pri":6,"time":"100.000000","msg":"example"}]}',
  '{"dmesg":[{"pri":6,"time":-1,"msg":"example"}]}',
  '{"dmesg":[{"pri":6,"time":1e309,"msg":"example"}]}',
  '{"dmesg":[{"pri":6,"time":100}]}',
])('rejects invalid or truncated input', input => {
  expect(parseGemmaKernelFaults(input, 99)).toEqual({
    status: 'unavailable',
    attribution: 'host-during-probe',
    events: [],
  })
})

test.each([-1, NaN, Infinity])(
  'rejects an invalid probe start time',
  sinceSeconds => {
    expect(
      parseGemmaKernelFaults(kernelInput([SEGFAULT]), sinceSeconds).status,
    ).toBe('unavailable')
  },
)

test('rejects oversized UTF-8 input before parsing', () => {
  const input = JSON.stringify({ dmesg: [], ignored: 'é'.repeat(600_000) })
  expect(parseGemmaKernelFaults(input, 0)).toEqual({
    status: 'unavailable',
    attribution: 'host-during-probe',
    events: [],
    truncated: true,
  })
})

test('distinguishes empty captures and retained-record truncation', () => {
  expect(parseGemmaKernelFaults('{"dmesg":[]}', 0)).toEqual({
    status: 'captured',
    attribution: 'host-during-probe',
    events: [],
  })
  const result = parseGemmaKernelFaults(
    kernelInput(Array.from({ length: 33 }, () => SEGFAULT)),
    99,
  )
  expect(result.status).toBe('captured')
  expect(result.events).toHaveLength(32)
  expect(result.truncated).toBe(true)
})

test('does not retain a partial result when a later record is malformed', () => {
  const input = JSON.stringify({
    dmesg: [{ pri: 6, time: 100, msg: SEGFAULT }, { msg: 'invalid' }],
  })
  expect(parseGemmaKernelFaults(input, 99)).toEqual({
    status: 'unavailable',
    attribution: 'host-during-probe',
    events: [],
  })
})
