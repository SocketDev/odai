import { expect, test } from 'vitest'
import {
  sanitizeGemmaBroker,
  sanitizeGemmaHistograms,
  sanitizeGemmaPreferences,
} from '../../../../scripts/repo/cache/diagnostic.mts'

test('keeps backend and availability evidence while discarding profile and asset paths', () => {
  expect(
    sanitizeGemmaBroker({
      models: [
        {
          name: 'private-model',
          backendType: 'CPU',
          weightsPath: '/private/weights.bin',
        },
      ],
      useCases: [
        {
          name: 'language_model',
          unavailableReason: 3,
          private: 'private-value',
        },
      ],
      assets: [
        { name: 'private-asset', state: 2, bytesDownloaded: 'private-value' },
      ],
      properties: [
        { description: 'Performance Class', value: 'GpuBlocked' },
        { description: 'Device Capable', value: 'true' },
        { description: 'Manifest Path', value: '/private/manifest' },
      ],
      modelCrashCount: 1,
      maxModelCrashCount: 3,
    }),
  ).toEqual({
    assets: [{ name: 'other', state: 2, stateLabel: 'background-installing' }],
    deviceCapable: true,
    maxModelCrashCount: 3,
    modelCrashCount: 1,
    models: [{ backendType: 'CPU' }],
    performanceClass: 'GpuBlocked',
    useCases: [{ name: 'language_model', unavailableReason: 3 }],
  })
})

test('identifies public component readiness without copying arbitrary asset text', () => {
  const noAssetError: string | null = null
  const result = sanitizeGemmaBroker({
    assets: [
      {
        name: 'gemma4_component',
        state: 4,
        version: '2026.8.7.929',
        bytesDownloaded: 2_475_399_520n,
        bytesTotal: 2_475_399_520n,
        error: noAssetError,
      },
      {
        name: 'generalized_safety_model_component',
        state: 3,
        error: 'private-value',
      },
      {
        name: 'gemma4_private_component',
        state: 99,
        version: 'private-value',
        bytesDownloaded: -1n,
        bytesTotal: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      },
    ],
    isAssetManagerInitialized: true,
    models: [
      {
        name: 'gemma4_cpu_model',
        backendType: 'CPU',
        folderSize: 2_475_399_520n,
      },
    ],
    useCases: [{ name: 'prompt_api_gemma4', assetsRequested: true }],
  })
  expect(result).toMatchObject({
    assets: [
      {
        name: 'gemma4_component',
        stateLabel: 'ready',
        version: '2026.8.7.929',
        bytesDownloaded: 2_475_399_520,
        bytesTotal: 2_475_399_520,
        hasError: false,
      },
      {
        name: 'generalized_safety_model_component',
        stateLabel: 'foreground-installing',
        hasError: true,
      },
      {
        name: 'other',
        stateLabel: 'unknown',
        version: undefined,
        bytesDownloaded: undefined,
        bytesTotal: undefined,
      },
    ],
    isAssetManagerInitialized: true,
    models: [{ folderSize: 2_475_399_520 }],
    useCases: [{ name: 'prompt_api_gemma4', assetsRequested: true }],
  })
  expect(JSON.stringify(result)).not.toContain('private')
})

test.each([
  [0, 'not-installed'],
  [1, 'registering'],
  [2, 'background-installing'],
  [3, 'foreground-installing'],
  [4, 'ready'],
  [5, 'uninstalling'],
])('labels component state %i as %s', (state, stateLabel) => {
  expect(
    sanitizeGemmaBroker({
      assets: [{ name: 'language_detection_model_component', state }],
    })?.assets,
  ).toMatchObject([{ name: 'language_detection_model_component', stateLabel }])
})

test('reads the Chromium on_device preference namespace only', () => {
  expect(
    sanitizeGemmaPreferences({
      optimization_guide: {
        on_device: {
          performance_class: 8,
          performance_class_version: '154.0.8037.0',
          model_crash_count: 2,
          credential: 'private-value',
        },
        model_execution: {
          performance_class: 1,
          performance_class_version: 'private-value',
        },
      },
      enterprise: { token: 'private-value' },
    }),
  ).toEqual({
    performanceClass: 8,
    performanceClassVersion: '154.0.8037.0',
    modelCrashCount: 2,
  })
  expect(
    sanitizeGemmaPreferences({
      optimization_guide: { model_execution: { performance_class: 8 } },
    }),
  ).toEqual({
    performanceClass: undefined,
    performanceClassVersion: undefined,
    modelCrashCount: undefined,
  })
})

test('reports public Gemma model identity and component version without its source path', () => {
  for (const separator of ['/', '\\']) {
    const weightsPath = [
      '',
      'private',
      'OptGuideManifestModel',
      'b'.repeat(64),
      '2026.8.7.929',
      'weights.bin',
    ].join(separator)
    expect(
      sanitizeGemmaBroker({
        models: [{ name: 'gemma4_2b_cpu', backendType: 'CPU', weightsPath }],
      }),
    ).toMatchObject({
      models: [
        {
          name: 'gemma4_2b_cpu',
          backendType: 'CPU',
          componentVersion: '2026.8.7.929',
        },
      ],
    })
  }
})

test('bounds diagnostic arrays and rejects malformed numeric measurements', () => {
  const model = { backendType: 'GPU (fastest inference)' }
  expect(
    sanitizeGemmaBroker({ models: Array.from({ length: 100 }, () => model) })
      ?.models,
  ).toHaveLength(64)
  expect(
    sanitizeGemmaPreferences({
      optimization_guide: {
        on_device: {
          performance_class: NaN,
          performance_class_version: 'private-value',
          model_crash_count: -2,
        },
      },
    }),
  ).toEqual({
    modelCrashCount: undefined,
    performanceClass: undefined,
    performanceClassVersion: undefined,
  })
  expect(
    sanitizeGemmaHistograms({
      histograms: [
        {
          name: 'OnDeviceModel.Test',
          count: 1,
          sum: 1,
          buckets: [
            { low: -1, high: 2, count: 1 },
            { low: 0, high: Infinity, count: 1 },
            { low: 0, high: 2, count: -1 },
          ],
        },
      ],
    }),
  ).toEqual([{ name: 'OnDeviceModel.Test', count: 1, sum: 1, buckets: [] }])
})

test('drops malformed broker values instead of copying arbitrary strings', () => {
  expect(
    sanitizeGemmaBroker({
      models: [{ backendType: 'private-value' }, undefined],
      useCases: [{ name: 'private-value', unavailableReason: 'private-value' }],
      modelCrashCount: -1,
      maxModelCrashCount: Infinity,
      properties: [
        { description: 'Performance Class', value: 'private-value' },
      ],
    }),
  ).toMatchObject({
    models: [{ backendType: 'unknown' }],
    useCases: [{ name: 'other', unavailableReason: undefined }],
    modelCrashCount: undefined,
    maxModelCrashCount: undefined,
    performanceClass: undefined,
  })
  expect(sanitizeGemmaBroker(undefined)).toBeUndefined()
})

test('limits histograms to model measurements and copies numeric bucket values', () => {
  expect(
    sanitizeGemmaHistograms({
      histograms: [
        {
          name: 'OnDeviceModel.LoadModelDuration',
          count: 1,
          sum: 20,
          private: 'private-value',
          buckets: [{ low: 10, high: 30, count: 1, private: 'private-value' }],
        },
        { name: 'Unrelated.Private', count: 1, sum: 0, buckets: [] },
        { name: 'OnDeviceModel.private/value', count: 1, sum: 0, buckets: [] },
        { name: 'OnDeviceModel.Invalid', count: -1, sum: 0, buckets: [] },
      ],
    }),
  ).toEqual([
    {
      name: 'OnDeviceModel.LoadModelDuration',
      count: 1,
      sum: 20,
      buckets: [{ low: 10, high: 30, count: 1 }],
    },
  ])
  expect(sanitizeGemmaHistograms(undefined)).toBeUndefined()
})

test('admits only the three process termination histograms', () => {
  const names = [
    'ChildProcess.Crashed2',
    'ChildProcess.DisconnectedAlive2',
    'ChildProcess.Killed2',
  ]
  const histograms = [
    ...names,
    'ChildProcess.Private',
    'ChildProcess.Crashed2.private',
  ].map(name => ({
    name,
    count: 1,
    sum: 2,
    buckets: [{ low: 1, high: 3, count: 1 }],
  }))
  expect(sanitizeGemmaHistograms({ histograms })?.map(row => row.name)).toEqual(
    names,
  )
})
