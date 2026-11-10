// Pose benchmark page (benchmark.html): a diagnostic, not a clinical test.
//
// Pairwise Full vs Lite PoseLandmarker (CPU, fresh instances per run) over one local
// clip, sampled at a fixed rate: each sample seeks to a fixed grid time, waits for a
// decoded frame, and measures the 2D rep angle on a fixed side (src/exercises.js).
// The core (src/pose-benchmark.js) does the measuring; this file only wires controls,
// decoding (src/benchmark-video.js), progress and results. Nothing leaves the device:
// the webcam is never requested, and no clip, file or label content is ever put on
// the network. The only network the benchmark uses is MediaPipe's normal download of
// the two pinned .task files, the same URLs as the app's model picker.

import './style.css'
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { exercises } from './exercises.js'
import { buildSampleGrid, runPoseBenchmark, benchmarkCsv, parseReferenceCsv, summarizeBenchmark } from './pose-benchmark.js'
import { createVideoDecoder } from './benchmark-video.js'
import { themeSwitch } from './theme.js'

// The two pinned asset paths of the main app (src/main.js), kept here so the
// benchmark never swaps a model without the labels and page saying so.
const ASSET = variant => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${variant}/float16/1/pose_landmarker_${variant}.task`
const MAX_SAMPLES = 1200

document.querySelector('#app').innerHTML = `
  <header class="topbar">
    <a class="brand" href="./">
      <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5v11M3.5 9v6M17.5 6.5v11M20.5 9v6M6.5 12h11"/></svg>
      Pose benchmark
    </a>
    <div class="topbar-end"><span id="theme-slot"></span></div>
  </header>

  <p class="hint"><a href="./">Back to Exercise Tracker</a> · Diagnostic tooling. Your clip, reference file and results stay on this device.</p>

  <div class="details-grid">
    <section class="card settings" aria-labelledby="setup-title">
      <h2 id="setup-title">Run</h2>
      <label>Local clip (decoded on this device)
        <input id="clip" type="file" accept="video/*">
      </label>
      <label>Exercise
        <select id="exercise">
          ${exercises.map(profile => `<option value="${profile.id}">${profile.name}</option>`).join('')}
        </select>
      </label>
      <label>Side (fixed for the whole run)
        <select id="side">
          <option value="left">Left</option>
          <option value="right">Right</option>
        </select>
      </label>
      <label>Sample rate (Hz, max 30)
        <select id="rate">
          ${[1, 2, 5, 10, 20, 30].map(rate => `<option value="${rate}"${rate === 10 ? ' selected' : ''}>${rate}</option>`).join('')}
        </select>
      </label>
      <label>Reference CSV, optional (<code>sample_index,angle_deg</code> per line)
        <input id="reference" type="file" accept=".csv,text/csv">
      </label>
      <div class="button-row">
        <button id="run" type="button" class="big-button start-button" disabled>Run</button>
        <button id="cancel" type="button" class="secondary" disabled>Cancel</button>
      </div>
      <div id="export-row" class="button-row" hidden>
        <button id="download" type="button" class="secondary">Download CSV</button>
      </div>
      <p id="status" class="hint" role="status" aria-live="polite">Choose a local clip to start.</p>
      <p class="hint">Inference timing is only the per-frame <code>detectForVideo</code> call. Seek/pause time,
      model download and load, decoding, drawing and the full camera-to-feedback latency of the live app are
      outside these numbers — this page is not a latency budget for it.</p>
    </section>

    <section class="card settings" aria-labelledby="method-title">
      <h2 id="method-title">How the measurement works</h2>
      <p class="hint">Both models process the same decoded image for each requested time, using fresh
      CPU instances and the selected exercise’s 2D rep angle. Images are scaled to at most 640 px on
      the long side. The angle thresholds and rep counter do not run here.</p>
      <p class="hint">Up to ${MAX_SAMPLES} samples per model. To add reference angles, first export
      a run and use its zero-based sample indices and requested times. Keep the clip, rate, exercise,
      and side fixed. Omit unlabelled samples from the reference CSV.</p>
      <p class="hint">Coverage is the share of samples with a usable angle. Reference error is shown
      only for labelled samples. Use the common labelled subset to compare models on the same frames.</p>
    </section>
  </div>
`

document.querySelector('#theme-slot').replaceWith(themeSwitch())

const el = id => document.querySelector(`#${id}`)
const clipInput = el('clip')
const exerciseSelect = el('exercise')
const sideSelect = el('side')
const rateSelect = el('rate')
const referenceInput = el('reference')
const runButton = el('run')
const cancelButton = el('cancel')
const exportRow = el('export-row')
const downloadButton = el('download')
const status = el('status')

const DEFAULT_STATUS = 'Choose a local clip to start.'
const state = { controller:null, exportText:null }

// Any settings change (or a failed run) drops the previous run's results and export,
// so nothing on screen still describes a run whose inputs no longer exist.
function invalidateResults(message = DEFAULT_STATUS) {
  state.exportText = null
  document.querySelector('#results')?.remove()
  exportRow.hidden = true
  setStatus(message)
}

function setStatus(message) {
  if (status.textContent !== message) status.textContent = message
}

function syncControls() {
  const running = Boolean(state.controller)
  for (const control of [clipInput, exerciseSelect, sideSelect, rateSelect, referenceInput]) control.disabled = running
  runButton.disabled = running || !clipInput.files[0]
  cancelButton.disabled = !running
}

clipInput.addEventListener('change', () => { invalidateResults(); syncControls() })
exerciseSelect.addEventListener('change', () => invalidateResults())
sideSelect.addEventListener('change', () => invalidateResults())
rateSelect.addEventListener('change', () => invalidateResults())
referenceInput.addEventListener('change', () => invalidateResults())

cancelButton.addEventListener('click', () => {
  if (!state.controller) return
  state.controller.abort()
  cancelButton.disabled = true
  setStatus('Cancelling…')
})

downloadButton.addEventListener('click', () => {
  if (!state.exportText) return
  const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
  const blob = new Blob([state.exportText], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `pose-benchmark-${stamp}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

const ms = value => Number.isFinite(value) ? `${value.toFixed(1)} ms` : 'n/a'
const deg = value => Number.isFinite(value) ? `${value.toFixed(1)}°` : 'n/a'
const percent = fraction => Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : 'n/a'

let vision = null
async function ensureVision() {
  vision ??= await FilesetResolver.forVisionTasks('/wasm')
  return vision
}

// Results are built as DOM nodes: file- and CSV-derived text goes in as text only,
// never as parsed markup.
function renderResults({ title, notes, panels }) {
  document.querySelector('#results')?.remove()
  const section = document.createElement('section')
  section.className = 'card'
  section.id = 'results'
  section.setAttribute('aria-labelledby', 'results-title')
  const heading = document.createElement('h2')
  heading.id = 'results-title'
  heading.textContent = title
  section.appendChild(heading)
  for (const note of notes) {
    const p = document.createElement('p')
    p.className = 'hint'
    p.textContent = note
    section.appendChild(p)
  }
  const grid = document.createElement('div')
  grid.className = 'details-grid'
  for (const panel of panels) grid.appendChild(panel)
  section.appendChild(grid)
  document.querySelector('#app').appendChild(section)
}

function modelPanel(variant, stats, hasReference) {
  const panel = document.createElement('article')
  panel.className = 'panel'
  const heading = document.createElement('h3')
  heading.textContent = variant
  const lines = [
    `Samples: ${stats.total}`,
    `Pose not detected: ${stats.poseDetectionFailures}`,
    `Angle unavailable (includes missing poses): ${stats.unassessable}`,
    `Angle coverage: ${percent(stats.coverage)}`,
    `Inference — median: ${ms(stats.medianInferenceMs)} · p95: ${ms(stats.p95InferenceMs)}`,
  ]
  if (hasReference) {
    lines.push(`Reference MAE: ${deg(stats.maeDeg)} · ${stats.matched} matched`,
      `Common-frame reference MAE: ${deg(stats.commonMaeDeg)} · ${stats.commonMatched} matched`)
  }
  const list = document.createElement('ul')
  for (const line of lines) {
    const item = document.createElement('li')
    item.textContent = line
    list.appendChild(item)
  }
  panel.append(heading, list)
  return panel
}

function createModel(variant) {
  // Fresh CPU VIDEO instances only: GPU is never attempted here (main.js may use it
  // live, which would put those timings in a different category from these).
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: ASSET(variant), delegate: 'CPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
  })
}

const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0))
window.addEventListener('pagehide', () => state.controller?.abort())

runButton.addEventListener('click', async () => {
  const file = clipInput.files[0]
  if (!file || state.controller) return
  const exercise = exercises.find(profile => profile.id === exerciseSelect.value)
  const side = sideSelect.value
  const sampleRateHz = Number(rateSelect.value)
  const referenceFile = referenceInput.files[0]
  const controller = new AbortController()
  state.controller = controller
  const { signal } = controller
  invalidateResults('Reading local clip…')
  syncControls()
  let decoder

  try {
    decoder = createVideoDecoder({ file })
    const { durationMs } = await decoder.open(signal)
    const sampleCount = buildSampleGrid({ durationMs, sampleRateHz }).length
    const references = referenceFile ? parseReferenceCsv(await referenceFile.text(), sampleCount) : new Map()
    signal.throwIfAborted()

    setStatus('Loading Full and Lite pose models on CPU…')
    await ensureVision()
    signal.throwIfAborted()
    const rows = await runPoseBenchmark({
      durationMs, sampleRateHz, profile:exercise, side, createModel, signal,
      async readFrame(timeMs, frameSignal) {
        await yieldToBrowser()
        return decoder.readFrame(timeMs, frameSignal)
      },
      onProgress({ done, total }) { setStatus(`Sampling ${done} of ${total}…`) },
    })
    signal.throwIfAborted()
    const { full, lite } = summarizeBenchmark(rows, references)
    state.exportText = benchmarkCsv(rows, { references, exerciseId:exercise.id, side, sampleRateHz })
    renderResults({
      title:'Results — Full vs Lite',
      notes:[
        `${exercise.name} · ${side} side · ${sampleRateHz} samples/s · 2D · CPU`,
        referenceFile ? `${references.size} reference labels. Common-frame errors use only labelled samples both models could assess.`
          : 'No reference angles supplied. Accuracy has not been measured.',
      ],
      panels:[modelPanel('Full', full, Boolean(referenceFile)), modelPanel('Lite', lite, Boolean(referenceFile))],
    })
    exportRow.hidden = false
    setStatus(`Done. Compared ${sampleCount} paired samples.`)
  } catch (error) {
    invalidateResults(signal.aborted ? 'Cancelled. No result saved.' : `Run stopped: ${error.message}`)
  } finally {
    decoder?.dispose()
    state.controller = null
    syncControls()
  }
})

syncControls()
