import {
  analyzeLockstep,
  parseLockstepInput,
  validateLockstepAnalysis,
  createAppleFmBackend,
  createBuiltinModel,
  createOdaiModel,
  installLanguageModelSimulator,
  summarizeText,
} from '@socketsecurity/odai'
import { allScenarios, runEval } from '@socketsecurity/odai/bench'

export async function runBrowserSmoke(): Promise<boolean> {
  installLanguageModelSimulator({
    fallback: '{"summary":"browser ready","keyPoints":[]}',
    rules: [
      {
        when: text => text.includes('use a template literal'),
        response: JSON.stringify({
          explanation: 'Use interpolation.',
          patch:
            '--- a/greet.js\n+++ b/greet.js\n@@ -1,3 +1,3 @@\n function greet(name) {\n-  console.log("Hello " + name);\n+  console.log(`Hello ${name}`);\n }\n',
        }),
      },
    ],
    target: globalThis,
  })
  for (const create of [
    createBuiltinModel,
    () => createOdaiModel({ backend: 'chrome-builtin' }),
  ]) {
    const model = await create()
    try {
      const result = await summarizeText(model, 'A browser consumer example.')
      if (!result.ok || result.data?.summary !== 'browser ready') {
        return false
      }
      const input = parseLockstepInput({
        version: 1,
        row: {
          id: 'packed-browser',
          kind: 'feature-parity',
          materialization: 'full',
          upstream: 'example',
          baseSha: 'a'.repeat(40),
          targetSha: 'b'.repeat(40),
          localAreas: ['src/parser'],
          testAreas: ['test/parser'],
          deviations: [],
          sparseCone: [],
        },
        evidence: [],
        truncated: false,
      })
      const analysis = await analyzeLockstep(model, input)
      if (
        !analysis.ok ||
        validateLockstepAnalysis(input, analysis.data).verdict !== 'abstain'
      ) {
        return false
      }
      const scenario = allScenarios.find(
        candidate => candidate.task === 'patch',
      )
      if (
        scenario === undefined ||
        (await runEval({ model, scenarios: [scenario] })).score !== 1
      ) {
        return false
      }
    } finally {
      model.rawSession().destroy?.()
    }
  }
  return !(await createAppleFmBackend().availability()).available
}
