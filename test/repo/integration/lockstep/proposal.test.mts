import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { strictDelete } from '../../../../scripts/fleet/fs/strict.mts'
import { describe, expect, it } from 'vitest'
import {
  createLockstepEvaluation,
  createLockstepEvaluationProposal,
} from '../../../../src/bench/lockstep/fixtures.mts'
import { verifyLockstepEvaluation } from '../../../../src/bench/lockstep/verify.mts'
import {
  changePatch,
  parseLockstepProposal,
} from '../../../../src/lockstep/proposal.mts'
import { parseOracleNodes } from '../../../../src/bench/verify-oracles.mts'

const git = promisify(execFile)

describe.each(['full', 'sparse'] as const)('%s Git patches', mode => {
  it.each([false, true])(
    'applies source and regression changes with final newline=%s',
    async newline => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), 'odai-lockstep-proposal-'),
      )
      try {
        const example = createLockstepEvaluation(mode)
        if (newline) {
          for (const item of example.input.evidence) {
            item.text += '\n'
          }
        }
        const analysis = parseLockstepProposal(
          example.input,
          createLockstepEvaluationProposal(example),
        )
        const localEvidence = example.input.evidence.filter(
          item => item.side !== 'upstream',
        )
        for (let i = 0, { length } = localEvidence; i < length; i += 1) {
          const evidence = localEvidence[i]!
          const file = path.join(root, evidence.path)
          await mkdir(path.dirname(file), { recursive: true })
          await writeFile(file, evidence.text)
        }
        const patchFile = path.join(root, 'change.patch')
        await writeFile(
          patchFile,
          analysis.patches.map(item => item.patch).join(''),
        )
        await git('git', ['apply', '--check', patchFile], {
          cwd: root,
          timeout: 5000,
        })
        await git('git', ['apply', patchFile], { cwd: root, timeout: 5000 })
        for (const item of analysis.patches) {
          expect(
            parseOracleNodes(
              await readFile(path.join(root, item.path), 'utf8'),
            ),
          ).toBeDefined()
        }
        expect(verifyLockstepEvaluation(example.input, analysis)).toBe(true)
      } finally {
        await strictDelete(root, { base: os.tmpdir() })
      }
    },
  )

  it('uses surrounding evidence at nonzero source line offsets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'odai-lockstep-range-'))
    try {
      const example = createLockstepEvaluation(mode)
      const local = example.input.evidence.find(item => item.side === 'local')!
      local.startLine = 2
      local.text = 'const before = 3\nexport const value = 5\nconst after = 7\n'
      const change = createLockstepEvaluationProposal(example).changes[0]!
      change.startLine = 3
      change.endLine = 3
      const patch = changePatch(example.input, change)!
      const file = path.join(root, local.path)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(
        file,
        `// outside evidence\n${local.text}// after evidence\n`,
      )
      const patchFile = path.join(root, 'range.patch')
      await writeFile(patchFile, patch)
      await git('git', ['apply', '--check', patchFile], {
        cwd: root,
        timeout: 5000,
      })
      await git('git', ['apply', patchFile], { cwd: root, timeout: 5000 })
      const nodes = parseOracleNodes(await readFile(file, 'utf8'))!
      const values = nodes
        .filter(node => node.type === 'Literal')
        .map(node => node['value'])
      expect(values).toEqual(expect.arrayContaining([3, 7, 8]))
      expect(values).toHaveLength(3)
    } finally {
      await strictDelete(root, { base: os.tmpdir() })
    }
  })

  it('rejects unchanged replacements and the phantom line after a final newline', () => {
    const example = createLockstepEvaluation(mode)
    const proposal = createLockstepEvaluationProposal(example)
    const local = example.input.evidence.find(item => item.side === 'local')!
    local.text += '\n'
    const change = proposal.changes[0]!
    change.text = 'export const value = 5\n'
    expect(changePatch(example.input, change)).toBeUndefined()
    change.startLine = 2
    change.endLine = 2
    expect(changePatch(example.input, change)).toBeUndefined()
  })
})
