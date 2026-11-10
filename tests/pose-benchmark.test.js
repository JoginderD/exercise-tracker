import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSampleGrid, runPoseBenchmark, parseReferenceCsv, summarizeBenchmark, benchmarkCsv } from '../src/pose-benchmark.js'

const PROFILE = {
  minVisibility: 0.5,
  landmarks: { left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 } },
  metrics: { elbow: ['shoulder', 'elbow', 'wrist'], trunk: { segment: ['hip', 'shoulder'] } },
  rep: { metric: 'elbow' },
  formRules: [],
}

function joint(x, y, visibility = 1) {
  return { x, y, z: 0, visibility }
}

// Left-side landmarks array (29 slots) with a fixed arm pose per sample index.
function landmarksAt(index) {
  const landmarks = Array.from({ length: 29 }, () => joint(0.5, 0.5, 0.9))
  landmarks[11] = joint(0.35, 0.3, 0.95)
  landmarks[13] = joint(0.3, 0.45 + 0.01 * (index % 5), 0.9)
  landmarks[15] = joint(0.2 + 0.02 * (index % 4), 0.55, 0.85)
  landmarks[23] = joint(0.4, 0.7, 0.75)
  return landmarks
}

function modelReturning(name, detect) {
  const closed = []
  return {
    name,
    closed,
    detectForVideo(image, timestampMs) {
      return detect(image, timestampMs)
    },
    close() { closed.push('closed') },
  }
}

const IMAGE = { width: 640, height: 480 }

test('buildSampleGrid: strictly increasing integer times, index-based', () => {
  const grid = buildSampleGrid({ durationMs: 550, sampleRateHz: 10 })
  assert.deepEqual(grid, [0, 100, 200, 300, 400, 500])
  for (let i = 1; i < grid.length; i++) {
    assert.ok(Number.isInteger(grid[i]) && grid[i] > grid[i - 1] && grid[i] < 550)
  }
})

test('buildSampleGrid: rejects bad duration/rate and enforces the 1200-row cap', () => {
  assert.throws(() => buildSampleGrid({ durationMs: 0, sampleRateHz: 10 }), RangeError)
  assert.throws(() => buildSampleGrid({ durationMs: NaN, sampleRateHz: 10 }), RangeError)
  assert.throws(() => buildSampleGrid({ durationMs: 1000, sampleRateHz: 0 }), RangeError)
  assert.throws(() => buildSampleGrid({ durationMs: 1000, sampleRateHz: 31 }), RangeError)
  assert.throws(() => buildSampleGrid({ durationMs: 1000, sampleRateHz: 12.5 }), RangeError)
  assert.throws(() => buildSampleGrid({ durationMs: 200_000, sampleRateHz: 30 }),
    /shorten the clip or lower sampleRateHz/)
})

test('buildSampleGrid: high rate caps at 1200 rows without float drift', () => {
  const grid = buildSampleGrid({ durationMs: 40_000, sampleRateHz: 30 })
  assert.equal(grid.length, 1200)
  for (let i = 1; i < grid.length; i++) assert.ok(grid[i] > grid[i - 1])
  assert.ok(grid[grid.length - 1] < 40_000)
})

test('runPoseBenchmark: flat one-row-per-model shape, paired runs share image/time/clock', async () => {
  let nowCalls = 0
  const clock = () => (nowCalls += 10)
  const seenImages = new Set()
  const seenTimes = new Set()
  const detectionCalls = []
  const models = {}
  const rows = await runPoseBenchmark({
    durationMs: 250,
    sampleRateHz: 10,
    profile: PROFILE,
    side: 'left',
    signal: new AbortController().signal,
    now: clock,
    readFrame: (timeMs) => {
      seenTimes.add(timeMs)
      seenImages.add(IMAGE)
      return IMAGE
    },
    createModel: async (variant) => {
      const model = modelReturning(variant, (image, timestampMs) => {
        detectionCalls.push({ variant, timestampMs, image })
        return { landmarks: [landmarksAt(timestampMs)] }
      })
      models[variant] = model
      return model
    },
  })
  assert.equal(rows.length, 6)
  assert.equal(seenImages.size, 1)
  for (const model of [models.full, models.lite]) assert.deepEqual(model.closed, ['closed'])
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), [
      'angle', 'assessable', 'imageHeight', 'imageWidth', 'inferenceMs', 'metrics', 'model',
      'poseDetected', 'sampleIndex', 'timeMs', 'visibility',
    ].sort())
    assert.equal(row.imageWidth, 640)
    assert.equal(row.imageHeight, 480)
    assert.ok(row.poseDetected && row.assessable)
    assert.ok(Number.isFinite(row.angle) && Number.isFinite(row.inferenceMs))
    assert.equal(row.inferenceMs, 10)
    assert.equal(row.metrics.elbow, row.angle)
    for (const key of ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle']) {
      assert.ok(key in row.visibility)
    }
    assert.equal(row.visibility.ankle, 0.9)
  }
  const perSample = new Map()
  for (const row of rows) {
    if (!perSample.has(row.sampleIndex)) perSample.set(row.sampleIndex, [])
    perSample.get(row.sampleIndex).push(row)
  }
  for (const [index, pair] of perSample) {
    assert.deepEqual(pair.map(row => row.model), ['full', 'lite'])
    const calls = detectionCalls.filter(call => call.timestampMs === pair[0].timeMs)
    assert.equal(calls.length, 2)
    assert.ok(new Set(calls.map(call => call.variant)).size === 2)
    if (index % 2 === 0) {
      assert.equal(calls[0].variant, 'full')
    } else {
      assert.equal(calls[0].variant, 'lite')
    }
  }
})

test('runPoseBenchmark: records no-pose and unassessable rows, zero visibility preserved', async () => {
  const rows = await runPoseBenchmark({
    durationMs: 300,
    sampleRateHz: 10,
    profile: PROFILE,
    side: 'left',
    readFrame: () => IMAGE,
    createModel: async (variant) => modelReturning(variant, (image, timestampMs) => {
      if (variant === 'lite') return undefined
      if (timestampMs === 200) return undefined
      const landmarks = landmarksAt(timestampMs)
      landmarks[15].visibility = 0
      return { landmarks: [landmarks] }
    }),
  })
  const full = rows.filter(row => row.model === 'full')
  assert.equal(full.length, 3)
  assert.equal(full[0].assessable, false)
  assert.equal(full[0].visibility.wrist, 0)
  assert.equal(rows.filter(row => row.model === 'lite').every(row => !row.poseDetected), true)
  assert.equal(rows.find(row => row.model === 'full' && !row.poseDetected).visibility.elbow, null)
})

test('runPoseBenchmark: abort mid-run throws without a partial complete result and closes models', async () => {
  const controller = new AbortController()
  const closed = []
  const created = []
  await assert.rejects(
    runPoseBenchmark({
      durationMs: 500,
      sampleRateHz: 10,
      profile: PROFILE,
      side: 'left',
      signal: controller.signal,
      readFrame: (timeMs) => {
        if (timeMs >= 200) controller.abort()
        return IMAGE
      },
      createModel: async (variant) => {
        const model = modelReturning(variant, () => ({ landmarks: [landmarksAt(0)] }))
        model.close = () => closed.push(variant)
        created.push(variant)
        return model
      },
    }),
    (error) => error.name === 'AbortError',
  )
  assert.deepEqual(closed.sort(), ['full', 'lite'])
  assert.deepEqual(created, ['full', 'lite'])
})

test('runPoseBenchmark: aborted before start throws immediately and closes nothing', async () => {
  const controller = new AbortController()
  controller.abort()
  const created = []
  await assert.rejects(
    runPoseBenchmark({
      durationMs: 100,
      sampleRateHz: 10,
      profile: PROFILE,
      side: 'left',
      signal: controller.signal,
      readFrame: () => IMAGE,
      createModel: async () => { created.push('model'); return modelReturning('x', () => undefined) },
    }),
    (error) => error.name === 'AbortError',
  )
  assert.deepEqual(created, [])
})

test('runPoseBenchmark: decode failure still closes both loaded models', async () => {
  const closed = []
  await assert.rejects(
    runPoseBenchmark({
      durationMs: 200,
      sampleRateHz: 10,
      profile: PROFILE,
      side: 'left',
      readFrame: (timeMs) => {
        if (timeMs === 0) throw new Error('decode failed')
      },
      createModel: async (variant) => {
        const model = modelReturning(variant, () => ({ landmarks: [landmarksAt(0)] }))
        model.close = () => closed.push(variant)
        return model
      },
    }),
    /decode failed/,
  )
  assert.deepEqual(closed.sort(), ['full', 'lite'])
})

test('runPoseBenchmark: model load failure closes the already-created model', async () => {
  const closed = []
  await assert.rejects(
    runPoseBenchmark({
      durationMs: 200,
      sampleRateHz: 10,
      profile: PROFILE,
      side: 'left',
      readFrame: () => IMAGE,
      createModel: async (variant) => {
        if (variant === 'lite') throw new Error('lite failed to load')
        const model = modelReturning('full', () => ({ landmarks: [landmarksAt(0)] }))
        model.close = () => closed.push('full')
        return model
      },
    }),
    /lite failed to load/,
  )
  assert.deepEqual(closed, ['full'])
})

const rowsFixture = () => {
  const rows = []
  for (let index = 0; index < 10; index++) {
    const timeMs = index * 100
    const fullAngle = index % 3 === 0 ? null : 90 + index
    const liteAngle = index === 5 ? null : 92 + index
    rows.push({
      sampleIndex: index, timeMs, model: 'full', poseDetected: fullAngle !== null, angle: fullAngle,
      assessable: fullAngle !== null, inferenceMs: 10 + index, metrics: { elbow: fullAngle, trunk: 20 },
      visibility: { shoulder: 0.9, elbow: 0.8, wrist: 0.7, hip: 0.6, knee: 0, ankle: null },
      imageWidth: 640, imageHeight: 480,
    })
    rows.push({
      sampleIndex: index, timeMs, model: 'lite', poseDetected: liteAngle !== null, angle: liteAngle,
      assessable: liteAngle !== null, inferenceMs: 5 + index, metrics: { elbow: liteAngle, trunk: 21 },
      visibility: { shoulder: 0.4, elbow: 0.5, wrist: 0, hip: null, knee: 0.1, ankle: 0.2 },
      imageWidth: 640, imageHeight: 480,
    })
  }
  return rows
}

test('summarizeBenchmark: calculates model-specific error on matched and common frames', () => {
  const rows = rowsFixture()
  const references = parseReferenceCsv('sample_index,angle_deg\n0,90\n2,95\n4,100\n5,99\n9,100', 10)
  const summary = summarizeBenchmark(rows, references)
  assert.equal(summary.full.total, 10)
  assert.equal(summary.full.poseDetectionFailures, 4)
  assert.equal(summary.full.unassessable, 4)
  assert.ok(Math.abs(summary.full.coverage - 0.6) < 1e-9)
  assert.equal(summary.full.medianInferenceMs, 14.5)
  assert.equal(summary.full.p95InferenceMs, 19)
  assert.equal(summary.full.matched, 3)
  assert.ok(Math.abs(summary.full.maeDeg - 13 / 3) < 1e-9)
  assert.equal(summary.lite.matched, 4)
  assert.ok(Math.abs(summary.lite.maeDeg - 2) < 1e-9)
  assert.equal(summary.full.commonMatched, 2)
  assert.equal(summary.lite.commonMatched, 2)
  assert.equal(summary.full.commonMaeDeg, 4.5)
  assert.equal(summary.lite.commonMaeDeg, 2.5)
})

test('summarizeBenchmark: missing/invalid references give null MAE', () => {
  const summary = summarizeBenchmark(rowsFixture(), new Map([[0, 95], [2, 91]]))
  assert.equal(summary.full.matched, 1)
  assert.equal(summary.full.maeDeg, 1)
  assert.equal(summary.lite.matched, 2)
  assert.equal(summary.full.commonMatched, 1)
  const empty = summarizeBenchmark(rowsFixture())
  assert.equal(empty.full.maeDeg, null)
  assert.equal(empty.lite.maeDeg, null)
  assert.equal(empty.full.commonMatched, 0)
  assert.equal(empty.full.commonMaeDeg, null)
})

test('parseReferenceCsv: BOM/CRLF and validation', () => {
  const references = parseReferenceCsv('\uFEFFsample_index,angle_deg\r\n0,90.5\r\n3,45.25\r\n')
  assert.equal(references.size, 2)
  assert.equal(references.get(0), 90.5)
  assert.equal(references.get(3), 45.25)
  assert.throws(() => parseReferenceCsv('index,angle\n0,90'), /expected header/)
  assert.throws(() => parseReferenceCsv('sample_index,angle_deg\n0,'), /nonempty/)
  assert.throws(() => parseReferenceCsv('sample_index,angle_deg\nx,90'), /non-negative integer/)
  assert.throws(() => parseReferenceCsv('sample_index,angle_deg\n0,181'), /\[0,180\]/)
  assert.throws(() => parseReferenceCsv('sample_index,angle_deg\n0,x'), /\[0,180\]/)
  assert.throws(() => parseReferenceCsv('sample_index,angle_deg\n0,90\n0,91'), /duplicate/)
  assert.throws(() => parseReferenceCsv('sample_index,angle_deg\n5,90', 5), /not below sampleCount/)
  assert.throws(() => parseReferenceCsv(42), TypeError)
})

test('benchmarkCsv: flat output, header/data column counts identical, zero vs missing', () => {
  const rows = rowsFixture()
  const references = parseReferenceCsv('sample_index,angle_deg\n0,90\n5,99', 10)
  const csv = benchmarkCsv(rows, { references, exerciseId: 'squat', side: 'left', sampleRateHz: 10 })
  const lines = csv.split('\n')
  assert.equal(lines.length, rows.length + 1)
  const header = lines[0].split(',')
  assert.deepEqual(header.slice(0, 13), ['sample_index', 'requested_time_ms', 'model', 'exercise', 'side',
    'sample_rate_hz', 'backend', 'pose_detected', 'assessable', 'angle_deg', 'inference_ms',
    'image_width', 'image_height'])
  assert.ok(header.includes('elbow_visibility') && header.includes('trunk_deg') && header.includes('reference_angle_deg'))
  for (const line of lines) assert.equal(line.split(',').length, header.length)
  assert.ok(csv.includes('squat,left,10,CPU'))
  const first = lines[1].split(',')
  assert.equal(first[header.indexOf('angle_deg')], '')
  assert.equal(first[header.indexOf('knee_visibility')], '0')
  assert.equal(first[header.indexOf('ankle_visibility')], '')
  assert.equal(first[header.indexOf('reference_angle_deg')], '90')
  assert.equal(first[header.indexOf('absolute_error_deg')], '')
})

test('benchmarkCsv: accepts runner rows end-to-end', async () => {
  const rows = await runPoseBenchmark({
    durationMs: 200,
    sampleRateHz: 10,
    profile: PROFILE,
    side: 'left',
    readFrame: () => IMAGE,
    createModel: async () => modelReturning('x', (image, timestampMs) => ({ landmarks: [landmarksAt(timestampMs)] })),
  })
  const csv = benchmarkCsv(rows, { references: new Map() })
  const lines = csv.split('\n')
  assert.equal(lines.length, rows.length + 1)
  const header = lines[0].split(',')
  for (const line of lines) assert.equal(line.split(',').length, header.length)
  assert.ok(lines.at(-1).startsWith('1,100,lite'))
})
