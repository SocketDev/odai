import type { LockstepInput } from '../../../../src/lockstep/schema.mts'

// The quoted source was read from these commits. No missing upstream text is reconstructed.
export function createSdxgenLockstepFixture(): LockstepInput {
  return {
    version: 1,
    row: {
      id: 'pypi-uv-lock',
      kind: 'feature-parity',
      materialization: 'full',
      upstream: 'uv',
      baseSha: '329541a503de8a4d9bb021814f9c0875efe033c8',
      targetSha: '329541a503de8a4d9bb021814f9c0875efe033c8',
      localAreas: ['src/parsers/pypi'],
      testAreas: ['test/integration/pypi'],
      sparseCone: [],
      deviations: [
        'Keep the TypeScript canonical scanner and the general TOML fallback for unrecognized constructs.',
      ],
    },
    evidence: [
      {
        id: 'sdxgen-fallback',
        side: 'local',
        path: 'src/parsers/pypi/uv-lock.mts',
        sha: '77fbb2773fd0962c3f1af7ddb5c132e51579e9ae',
        startLine: 349,
        text: 'export function parseUvLockText(text: string): UvLock {\n  const canonical = parseUvLockCanonical(text)\n  if (canonical !== undefined) {\n    return canonical\n  }\n  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parse-boundary assertion to the documented lockfile/manifest shape; malformed input is handled by downstream guards.\n  return parseTomlRaw(text) as UvLock\n}',
      },
    ],
    truncated: false,
  }
}

export function createOdaiLockstepFixture(): LockstepInput {
  return {
    version: 1,
    row: {
      id: 'llama-cpp-server-wire-format',
      kind: 'spec-conformance',
      materialization: 'sparse',
      upstream: 'llama.cpp',
      baseSha: '9d77fa17254e1dee4b9e92504c91611a60b1359f',
      targetSha: '9d77fa17254e1dee4b9e92504c91611a60b1359f',
      localAreas: ['src/shim'],
      testAreas: ['test/integration'],
      sparseCone: ['tools/server'],
      deviations: [],
    },
    evidence: [
      {
        id: 'llama-open-chunk',
        side: 'upstream',
        path: 'tools/server/tests/unit/test_chat_completion.py',
        sha: '9d77fa17254e1dee4b9e92504c91611a60b1359f',
        startLine: 110,
        text: '            if choice["finish_reason"] in ["stop", "length"]:\n                assert "content" not in choice["delta"]\n                assert match_regex(re_content, content)\n                assert choice["finish_reason"] == finish_reason\n            else:\n                assert choice["finish_reason"] is None\n                content += choice["delta"]["content"] or \'\'',
      },
      {
        id: 'odai-open-chunk',
        side: 'local',
        path: 'src/shim/openai.mts',
        sha: '5dd65cfa21b755f851d4f64e2bf608a73f619405',
        startLine: 296,
        text: 'export function openStreamChoice(\n  delta: Record<string, unknown>,\n): Record<string, unknown> {\n  return {\n    delta,\n    // oxlint-disable-next-line socket/prefer-undefined-over-null -- chat.completion.chunk wire format: an open frame carries an explicit null finish_reason.\n    finish_reason: null,\n    index: 0,\n  }\n}',
      },
    ],
    truncated: false,
  }
}
