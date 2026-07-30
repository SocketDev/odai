import { describe, expect, it } from 'vitest'

import { runTask } from '../../src/cli/dispatch.mts'
import { createMockModel } from '../../src/node.mts'

describe('runTask', () => {
  const model = createMockModel(
    '{"summary":"s","keyPoints":["a"],"subject":"chore: x",' +
      '"sentences":["one"],"topConcern":"low",' +
      '"patch":"--- a\\n+++ b","explanation":"why",' +
      '"routine":true,"reason":"pin bump","risk":"low"}',
  )

  it('routes classify-deps', async () => {
    const result = await runTask('classify-deps', model, 'diff', undefined)
    expect(result).toHaveProperty('ok')
  })

  it('routes commit-msg', async () => {
    const result = await runTask('commit-msg', model, 'diff', undefined)
    expect(result).toHaveProperty('ok')
  })

  it('routes summarize', async () => {
    const result = await runTask('summarize', model, 'text', undefined)
    expect(result).toHaveProperty('ok')
  })

  it('routes triage', async () => {
    const result = await runTask('triage', model, 'findings', undefined)
    expect(result).toHaveProperty('ok')
  })

  it('routes patch with an instruction', async () => {
    const result = await runTask('patch', model, 'file', 'use template literal')
    expect(result).toHaveProperty('ok')
  })

  it('rejects patch without an instruction', async () => {
    await expect(runTask('patch', model, 'file', undefined)).rejects.toThrow(
      /needs --instruction/,
    )
  })

  it('routes lockfile + the JSON-input dep-update commands', async () => {
    const cases = [
      ['lockfile', '{"packages":{}}'],
      ['dedupe', '{"manifest":"{}","lockfile":"x"}'],
      [
        'hoist',
        '{"changelog":"c","currentVersion":"1.0.0","targetVersion":"2.0.0","minNodeSupported":22}',
      ],
      [
        'security-fix',
        '{"advisory":"a","affectedRange":"<2.0.0","availableVersions":["2.0.0"],"currentVersion":"1.0.0"}',
      ],
      ['weekly-update', '{"outdated":"x","soakWindowDays":7}'],
    ] as const
    for (const [command, input] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- sequential mock dispatch
      expect(await runTask(command, model, input, undefined)).toHaveProperty(
        'ok',
      )
    }
  })

  it('rejects a JSON-input command given non-JSON stdin', async () => {
    await expect(runTask('hoist', model, 'x', undefined)).rejects.toThrow(
      /expects JSON/,
    )
  })

  it('rejects a command that is not a prompt task', async () => {
    await expect(
      runTask('backends' as never, model, 'x', undefined),
    ).rejects.toThrow(/not a prompt command/)
  })
})
