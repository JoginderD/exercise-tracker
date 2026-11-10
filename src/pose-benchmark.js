import { measurePose } from './exercise-tracker.js'

export const MAX_SAMPLES = 1200
const MODELS = ['full', 'lite']

export function buildSampleGrid({ durationMs, sampleRateHz = 10 } = {}) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError(`durationMs must be a finite number > 0, got ${durationMs}`)
  }
  if (!Number.isInteger(sampleRateHz) || sampleRateHz < 1 || sampleRateHz > 30) {
    throw new RangeError(`sampleRateHz must be an integer in [1,30], got ${sampleRateHz}`)
  }
  const intervalMs = 1000 / sampleRateHz
  // Index-based times (round(i * interval)), no float accumulation, strictly increasing, all < durationMs.
  const grid = []
  for (let i = 0; ; i++) {
    const ms = Math.round(i * intervalMs)
    if (!(ms < durationMs) || (grid.length > 0 && ms <= grid[grid.length - 1])) break
    if (grid.length >= MAX_SAMPLES) {
      throw new RangeError(`sample grid exceeds the ${MAX_SAMPLES}-row cap (${durationMs}ms at ${sampleRateHz}Hz); shorten the clip or lower sampleRateHz`)
    }
    grid.push(ms)
  }
  return grid
}

export async function runPoseBenchmark({
  durationMs,
  sampleRateHz = 10,
  profile,
  side,
  readFrame,
  createModel,
  signal,
  onProgress,
  now = () => performance.now(),
} = {}) {
  if (!profile) throw new TypeError('profile is required')
  if (side !== 'left' && side !== 'right') throw new RangeError('side must be "left" or "right"')
  if (typeof readFrame !== 'function') throw new TypeError('readFrame is required')
  if (typeof createModel !== 'function') throw new TypeError('createModel is required')

  const grid = buildSampleGrid({ durationMs, sampleRateHz })
  const models = new Map()
  try {
    signal?.throwIfAborted()
    for (const variant of MODELS) {
      const model = await createModel(variant)
      if (model) models.set(variant, model)
      if (!model || typeof model.detectForVideo !== 'function') {
        throw new TypeError(`model ${variant} has no detectForVideo`)
      }
      signal?.throwIfAborted()
    }
    const rows = []
    for (let index = 0; index < grid.length; index++) {
      signal?.throwIfAborted()
      const timeMs = grid[index]
      const image = await readFrame(timeMs, signal)
      signal?.throwIfAborted()
      if (!image || typeof image !== 'object') {
        throw new TypeError(`readFrame returned no image at sample ${index} (t=${timeMs}ms)`)
      }
      const order = index % 2 === 0 ? MODELS : [...MODELS].reverse()
      const detections = new Map()
      for (const variant of order) {
        const instance = models.get(variant)
        const start = now()
        const result = instance.detectForVideo(image, timeMs)
        const inferenceMs = now() - start
        detections.set(variant, { result, inferenceMs })
      }
      for (const model of MODELS) {
        rows.push(rowFromResult({ sampleIndex:index, timeMs, model, image, side, profile, ...detections.get(model) }))
      }
      onProgress?.({ done: index + 1, total: grid.length })
      signal?.throwIfAborted()
    }
    return rows
  } finally {
    for (const model of models.values()) {
      try { model.close?.() } catch { /* cleanup must not mask a run failure */ }
    }
  }
}

function rowFromResult({ sampleIndex, timeMs, model, image, side, profile, result, inferenceMs }) {
  const landmarks = result?.landmarks?.[0]
  const measurement = measurePose(landmarks, side, image.width, image.height, profile)
  const metrics = Object.fromEntries(Object.keys(profile.metrics).map(key => [
    key, measurement?.metrics[key] ?? null,
  ]))
  const value = metrics[profile.rep.metric]
  const assessable = Number.isFinite(value)
  const visibility = Object.fromEntries(Object.entries(profile.landmarks[side]).map(([name, index]) => {
    const score = landmarks?.[index]?.visibility
    return [name, Number.isFinite(score) ? score : null]
  }))
  return {
    sampleIndex, timeMs, model, poseDetected:Boolean(landmarks?.length),
    angle:assessable ? value : null, assessable, inferenceMs, metrics, visibility,
    imageWidth:image.width, imageHeight:image.height,
  }
}

export function parseReferenceCsv(text, sampleCount) {
  if (typeof text !== 'string') throw new TypeError('reference CSV must be a string')
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() !== '')
  if (lines[0] !== 'sample_index,angle_deg') {
    throw new Error(`reference CSV: expected header "sample_index,angle_deg", got "${lines[0]}"`)
  }
  const references = new Map()
  for (let i = 1; i < lines.length; i++) {
    const columns = lines[i].split(',')
    if (columns.length !== 2 || columns[0].trim() === '' || columns[1].trim() === '') {
      throw new Error(`reference CSV line ${i + 1}: expected nonempty "sample_index,angle_deg", got "${lines[i]}"`)
    }
    const sampleIndex = Number(columns[0].trim())
    if (!/^\d+$/.test(columns[0].trim()) || !Number.isSafeInteger(sampleIndex)) {
      throw new Error(`reference CSV line ${i + 1}: sample_index must be a non-negative integer, got "${columns[0]}"`)
    }
    if (sampleCount !== undefined && sampleIndex >= sampleCount) {
      throw new Error(`reference CSV line ${i + 1}: sample_index ${sampleIndex} is not below sampleCount ${sampleCount}`)
    }
    if (references.has(sampleIndex)) {
      throw new Error(`reference CSV line ${i + 1}: duplicate sample_index ${sampleIndex}`)
    }
    const angle = Number(columns[1].trim())
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(columns[1].trim()) || !Number.isFinite(angle) || angle > 180) {
      throw new Error(`reference CSV line ${i + 1}: angle_deg must be a finite number within [0,180], got "${columns[1]}"`)
    }
    references.set(sampleIndex, angle)
  }
  return references
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// p95 uses the nearest-rank definition: ceil(0.95 * n)-th smallest, 1-based.
function p95(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]
}

function mae(values) {
  if (!values.length) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function stats(rows) {
  const assessable = rows.filter(row => row.assessable)
  const inference = rows.map(row => row.inferenceMs).filter(Number.isFinite)
  return {
    total: rows.length,
    poseDetectionFailures: rows.filter(row => !row.poseDetected).length,
    unassessable: rows.length - assessable.length,
    coverage: rows.length ? assessable.length / rows.length : null,
    medianInferenceMs: median(inference),
    p95InferenceMs: p95(inference),
  }
}

export function summarizeBenchmark(rows, references = new Map()) {
  if (!(references instanceof Map)) throw new TypeError('references must be a Map')
  const byModel = Object.fromEntries(MODELS.map(model => [model, rows.filter(row => row.model === model)]))
  const labelled = Object.fromEntries(MODELS.map(model => [
    model, byModel[model].filter(row => row.assessable && references.has(row.sampleIndex)),
  ]))
  const liteIndices = new Set(labelled.lite.map(row => row.sampleIndex))
  const common = new Set(labelled.full.filter(row => liteIndices.has(row.sampleIndex)).map(row => row.sampleIndex))
  const errors = entries => entries.map(row => Math.abs(row.angle - references.get(row.sampleIndex)))
  return Object.fromEntries(MODELS.map(model => [model, {
    ...stats(byModel[model]),
    matched:labelled[model].length,
    maeDeg:mae(errors(labelled[model])),
    commonMatched:common.size,
    commonMaeDeg:mae(errors(labelled[model].filter(row => common.has(row.sampleIndex)))),
  }]))
}

export function benchmarkCsv(rows, { references = new Map(), exerciseId = '', side = '', sampleRateHz = 10 } = {}) {
  if (!(references instanceof Map)) throw new TypeError('references must be a Map')
  const metrics = Object.keys(rows[0]?.metrics ?? {})
  const joints = Object.keys(rows[0]?.visibility ?? {})
  const headers = ['sample_index', 'requested_time_ms', 'model', 'exercise', 'side', 'sample_rate_hz',
    'backend', 'pose_detected', 'assessable', 'angle_deg', 'inference_ms', 'image_width', 'image_height',
    ...metrics.map(name => name + '_deg'),
    ...joints.map(name => `${name}_visibility`),
    'reference_angle_deg', 'absolute_error_deg']
  const format = value => (Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '')
  const escape = value => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  const lines = [headers.map(escape).join(',')]
  for (const row of rows) {
    const reference = references.get(row.sampleIndex) ?? null
    const error = reference !== null && row.assessable ? Math.abs(row.angle - reference) : null
    const cells = [
      row.sampleIndex, row.timeMs, row.model, exerciseId, side, sampleRateHz, 'CPU',
      row.poseDetected ? 'true' : 'false', row.assessable ? 'true' : 'false',
      format(row.angle), format(row.inferenceMs), row.imageWidth, row.imageHeight,
      ...metrics.map(name => format(row.metrics[name])),
      ...joints.map(name => format(row.visibility[name])),
      format(reference), format(error),
    ]
    if (cells.length !== headers.length) throw new Error('benchmarkCsv: header/data column count mismatch')
    lines.push(cells.map(escape).join(','))
  }
  return lines.join('\n')
}
