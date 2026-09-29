import { describe, expect, test, vi } from 'vitest'

import { runTask } from '../../../../src/cli/dispatch.mts'
import { isTaskCommand } from '../../../../src/cli/commands.mts'
import { createMockModel } from '../../../../src/mock.mts'
import { classifyReleaseBump } from '../../../../src/tasks/release-bump.mts'

describe('classifyReleaseBump', () => {
  test('first release is minor even when the model suggests patch', async () => {
    const model = createMockModel(
      JSON.stringify({ level: 'patch', notes: ['Introduces the package.'] }),
    )
    const result = await classifyReleaseBump(model, {
      commits: ['fix: correct package metadata'],
      firstRelease: true,
    })

    expect(result.data).toEqual({
      level: 'minor',
      notes: ['Introduces the package.'],
    })
  })

  test('later releases keep the model classification', async () => {
    const model = createMockModel(
      JSON.stringify({ level: 'patch', notes: ['Corrects a defect.'] }),
    )
    const result = await classifyReleaseBump(model, {
      commits: ['fix: correct package metadata'],
      firstRelease: false,
    })

    expect(result.data?.level).toBe('patch')
  })

  test('rejects unbounded or malformed input before calling the model', async () => {
    const model = createMockModel('')
    const prompt = vi.spyOn(model, 'promptStructured')

    await expect(
      classifyReleaseBump(model, {
        commits: [''],
        firstRelease: false,
      }),
    ).rejects.toThrow(/bounded commit text/)
    expect(prompt).not.toHaveBeenCalled()
  })

  test('is exposed as a CLI task with structured JSON input', async () => {
    const model = createMockModel(
      JSON.stringify({ level: 'patch', notes: ['Initial release.'] }),
    )
    expect(isTaskCommand('release-bump')).toBe(true)

    const result = await runTask(
      'release-bump',
      model,
      JSON.stringify({
        commits: ['fix: correct package metadata'],
        firstRelease: true,
      }),
      undefined,
    )
    expect(result.data).toMatchObject({ level: 'minor' })
  })
})
