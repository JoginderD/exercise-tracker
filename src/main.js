import './style.css'
import { createAccount } from './account.js'
import { createAngleGraph } from './angle-graph.js'
import { exercises } from './exercises.js'
import { bodyTurn, chooseSide, createTracker, createTurnGuide, hiddenJoints, measurePose } from './exercise-tracker.js'
import { buildSessionRecord, newRunId } from './session-record.js'
import { createMetricSmoother, createPointSmoother } from './smoothing.js'
import {
  PoseLandmarker,
  FilesetResolver,
} from '@mediapipe/tasks-vision'

let exercise = exercises[0]
let lanes = []

document.querySelector('#app').innerHTML = `
  <nav id="account-bar" class="account-bar" aria-label="Account"></nav>
  <main id="account-view" hidden></main>
  <div id="tracker-view">
  <h1 id="title">Exercise Tracker</h1>
  <p id="instructions"></p>

  <div class="settings">
    <div class="exercise-picker">
      <span id="exercise-label">Exercise:</span>
      <div id="exercise" class="toggle-group" role="group" aria-labelledby="exercise-label">
        ${exercises.map(profile => `<button type="button" data-id="${profile.id}" aria-pressed="false">${profile.name}</button>`).join('')}
      </div>
    </div>
    <label>
      Side to track:
      <select id="side">
        <option value="left">Left</option>
        <option value="right">Right</option>
        <option value="auto">Auto (clearer side)</option>
        <option value="each">Each side separately</option>
      </select>
    </label>
    <label>
      Model:
      <select id="model">
        <option value="lite">Lite (fastest)</option>
        <option value="full" selected>Full</option>
        <option value="heavy">Heavy (most accurate)</option>
      </select>
    </label>
    <label><input id="world" type="checkbox" checked> 3D angles</label>
    <p class="hint">3D angles use MediaPipe's depth estimate, so they stay accurate when you are not
    exactly side-on or face-on. Untick to measure flat image angles instead.</p>
  </div>

  <div class="video-input">
    <label>Open local test video: <input id="video-file" type="file" accept="video/*" disabled></label>
    <p id="video-name" class="hint">No video selected. Files are processed locally, never uploaded.</p>
    <button id="replay" disabled>Replay from start</button>
  </div>

  <div class="camera-container" id="camera-container">
    <div class="stage" id="stage">
      <video id="webcam" playsinline muted></video>
      <canvas id="overlay"></canvas>
      <div class="hud">
        <div class="hud-top-left">
          <button id="fullscreen" class="hud-button" type="button">Full screen</button>
          <p id="status" class="hud-status">Loading pose model…</p>
        </div>
        <div class="hud-stats">
          <span class="hud-label">Reps</span>
          <div id="reps" class="hud-reps">0</div>
          <div class="hud-details">
            <p id="angle"></p>
            <p id="metrics"></p>
            <p id="rep-counts"></p>
            <p id="flagged"></p>
          </div>
        </div>
        <div class="hud-bottom">
          <p id="turn" class="hud-turn" role="status" hidden></p>
          <p id="rep-feedback" class="hud-message" data-state="unassessable" role="status"></p>
          <p id="form" class="hud-message" data-state="unassessable" role="status">Form check waiting for camera.</p>
        </div>
      </div>
    </div>
  </div>

  <section class="angle-chart" aria-labelledby="graph-title">
    <h2 id="graph-title"></h2>
    <canvas id="angle-graph" role="img"></canvas>
    <p class="hint"><span id="graph-legend"></span><br>
    Gaps mean tracking is unavailable. The graph pauses when playback or the camera stops.</p>
  </section>

  <p id="rules" class="hint"></p>

  <div>
    <button id="start" disabled>Start Camera</button>
    <button id="stop" disabled>Stop Camera</button>
  </div>
  <p id="save-status" class="hint save-status" role="status"></p>
  </div>
`

const angleGraph = createAngleGraph(document.querySelector('#angle-graph'))
const video = document.querySelector('#webcam')
const canvas = document.querySelector('#overlay')
const ctx = canvas.getContext('2d')
const status = document.querySelector('#status')
const title = document.querySelector('#title')
const instructions = document.querySelector('#instructions')
const graphTitle = document.querySelector('#graph-title')
const graphCanvas = document.querySelector('#angle-graph')
const graphLegend = document.querySelector('#graph-legend')
const angleLabel = document.querySelector('#angle')
const metricsLabel = document.querySelector('#metrics')
const formLabel = document.querySelector('#form')
const flaggedLabel = document.querySelector('#flagged')
const repFeedbackLabel = document.querySelector('#rep-feedback')
const repCountsLabel = document.querySelector('#rep-counts')
const turnLabel = document.querySelector('#turn')
const cameraContainer = document.querySelector('#camera-container')
const stage = document.querySelector('#stage')
const fullscreenButton = document.querySelector('#fullscreen')
const rulesLabel = document.querySelector('#rules')
const exerciseToggles = document.querySelector('#exercise')
const sideSelect = document.querySelector('#side')
const modelSelect = document.querySelector('#model')
const worldToggle = document.querySelector('#world')
const startButton = document.querySelector('#start')
const stopButton = document.querySelector('#stop')
const fileInput = document.querySelector('#video-file')
const videoName = document.querySelector('#video-name')
const replayButton = document.querySelector('#replay')
const account = createAccount({
  bar:document.querySelector('#account-bar'),
  view:document.querySelector('#account-view'),
  trackerView:document.querySelector('#tracker-view'),
  saveStatus:document.querySelector('#save-status'),
  onLeaveTracker:() => stopCamera(),
})

let model
let vision
let modelRequest = 0
let stream
let running = false
let animationId
let lastVideoTime = -1
let source = 'camera'
let fileUrl
let cameraRequest = 0

const repsLabel = document.querySelector('#reps')
const LANE_COLORS = [['Cyan', '#22d3ee'], ['Pink', '#f472b6']]
const EMPTY = {
  reps:0, flaggedReps:0, partialReps:0, fastReps:0, slowReps:0,
  lastRep:null, waiting:true, form:'unassessable', messages:[], tempoMessage:null,
}

const capitalise = text => text[0].toUpperCase() + text.slice(1)
const degrees = value => Number.isFinite(value) ? `${value.toFixed(0)}°` : '—'
const seconds = ms => `${(ms / 1000).toFixed(1)} s`
const list = items => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]
const jointNames = () => Object.keys(exercise.landmarks.left)
const jointList = () => list(jointNames())
// Names the joints that are actually missing, e.g. "left wrist, right elbow and wrist".
const hiddenText = hidden => hidden.length
  ? list(hidden.map(lane => `${lanes.length > 1 || lane.side === 'auto' ? `${lane.current ?? laneName(lane)} ` : ''}${list(lane.hidden.length ? lane.hidden : jointNames())}`))
  : `keep ${jointList()} visible`
const laneName = lane => lane.side === 'auto' ? `Auto (${lane.current ?? '—'})` : capitalise(lane.side)
// One tracked limb shows a bare value; several are prefixed with their side.
const perLane = format => lanes.length === 1
  ? format(lanes[0])
  : lanes.map(lane => `${laneName(lane)} ${format(lane)}`).join(' · ')

function createLanes() {
  const sides = sideSelect.value === 'each' ? ['left', 'right'] : [sideSelect.value]
  return sides.map((side, index) => ({
    id: side,
    side,
    current: side === 'auto' ? null : side,
    colorName: LANE_COLORS[index][0],
    color: LANE_COLORS[index][1],
    tracker: createTracker(exercise),
    smoother: createMetricSmoother(exercise.maxGapMs),
    pointSmoother: createPointSmoother(exercise.maxGapMs),
    points: null,
    measurement: null,
    hidden: [],
    metrics: null,
    assessment: EMPTY,
  }))
}

function renderMeasurements() {
  const { labels, rep } = exercise
  angleLabel.textContent = `${labels[rep.metric]}: ${perLane(lane => degrees(lane.metrics?.[rep.metric]))}`
  metricsLabel.textContent = Object.keys(exercise.metrics)
    .filter(name => name !== rep.metric)
    .map(name => `${labels[name]}: ${perLane(lane => degrees(lane.metrics?.[name]))}`)
    .join(' | ')
  renderReps()
  flaggedLabel.textContent = `Flagged reps: ${perLane(lane => lane.assessment.flaggedReps)}`
  repCountsLabel.textContent = [
    ...exercise.tempo ? [
      `Too fast: ${perLane(lane => lane.assessment.fastReps)}`,
      `Too slow: ${perLane(lane => lane.assessment.slowReps)}`,
    ] : [],
    `Partial (not counted): ${perLane(lane => lane.assessment.partialReps)}`,
  ].join(' | ')
}

// One big counter per tracked limb, in that limb's graph colour.
function renderReps() {
  const key = lanes.map(lane => `${laneName(lane)}:${lane.assessment.reps}`).join()
  if (repsLabel.dataset.key === key) return
  repsLabel.dataset.key = key
  repsLabel.replaceChildren(...lanes.map(lane => {
    const item = document.createElement('span')
    item.className = 'hud-rep'
    item.style.color = lane.color
    if (lanes.length > 1) {
      const label = document.createElement('small')
      label.textContent = laneName(lane)
      item.append(label)
    }
    item.append(String(lane.assessment.reps))
    return item
  }))
}

// Live stalls first, then the start cue, then the verdict on the latest rep.
function laneFeedback({ tempoMessage, waiting, lastRep }) {
  if (tempoMessage) return { state:'warning', text:tempoMessage }
  if (waiting) return { state:'pending', text:exercise.startCue }
  if (!lastRep) return { state:'unassessable', text:'Waiting for the first rep.' }
  if (lastRep.kind === 'partial') {
    const needed = lastRep.missed === 'target' ? exercise.rep.target : exercise.rep.start
    return { state:'warning', text:`${lastRep.messages[0]} Reached ${degrees(lastRep.reached)}, needs ${needed}°.` }
  }
  if (!lastRep.tempo) return { state:'within', text:`Rep ${lastRep.number} counted.` }
  const timing = `Rep ${lastRep.number}: lift ${seconds(lastRep.liftMs)} · lower ${seconds(lastRep.lowerMs)}`
  return lastRep.tempo === 'good'
    ? { state:'within', text:`${timing} — good tempo.` }
    : { state:'warning', text:`${timing} — ${lastRep.messages.join(' ')}` }
}

function renderRepFeedback() {
  const feedback = lanes.map(lane => ({ lane, ...laneFeedback(lane.assessment) }))
  const state = ['warning', 'pending', 'within', 'unassessable'].find(form => feedback.some(item => item.state === form))
  const text = feedback.map(({ lane, text }) => lanes.length > 1 ? `${laneName(lane)}: ${text}` : text).join(' ')
  repFeedbackLabel.dataset.state = state
  setText(repFeedbackLabel, text)
}

// Rewriting identical text every frame would make screen readers repeat it.
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text
}

const roundTo5 = value => Math.max(5, Math.round(value / 5) * 5)
function renderTurn(guide) {
  turnLabel.hidden = !guide?.active
  if (!guide?.active) return
  const off = Number.isFinite(guide.deviation) ? ` (about ${roundTo5(guide.deviation)}° off)` : ''
  setText(turnLabel, exercise.facing === 'side'
    ? guide.turn ? `Keep turning to your ${guide.turn} to stand side-on${off}.` : 'Turn side-on to the camera.'
    : `Turn to your ${guide.turn} to face the camera${off}.`)
}

function renderForm() {
  const states = lanes.map(lane => lane.assessment.form)
  const state = ['warning', 'pending', 'unassessable', 'within'].find(form => states.includes(form))
  const prefix = lane => lanes.length > 1 ? `${laneName(lane)}: ` : ''
  formLabel.dataset.state = state
  if (state === 'warning') {
    formLabel.textContent = lanes.flatMap(lane => lane.assessment.messages.map(message => prefix(lane) + message)).join(' ')
  } else if (state === 'pending') {
    formLabel.textContent = 'Checking form…'
  } else if (state === 'unassessable') {
    const hidden = lanes.filter(lane => lane.assessment.form === 'unassessable')
    formLabel.textContent = `Cannot check form${lanes.length > 1 ? ` (${list(hidden.map(laneName))})` : ''}: ${hiddenText(hidden)}.`
  } else {
    formLabel.textContent = exercise.formRules.length
      ? 'Form within the configured limits.'
      : 'Tracking. This exercise has no form rules yet.'
  }
}

function clearMeasurements(message) {
  for (const lane of lanes) {
    lane.measurement = null
    lane.metrics = null
  }
  renderMeasurements()
  renderRepFeedback()
  formLabel.dataset.state = 'unassessable'
  formLabel.textContent = message
}

let turnGuide
// The run being recorded. Settings are captured when it begins, because the
// controls already show the new values by the time the old run is finished.
let run
let leavingPage = false

function beginRun() {
  run = {
    id:newRunId(), exercise, source:source === 'file' ? 'video' : 'camera',
    side:sideSelect.value, angles:worldToggle.checked ? '3d' : '2d', startedAt:null, endedAt:null,
  }
}

// Hands the run that is ending to the account for saving, then starts a fresh one.
function finishRun() {
  if (!run) return
  if (run.startedAt) {
    for (const lane of lanes) lane.tracker.resetSequence()
    account.saveSession(buildSessionRecord({ ...run, lanes }), { leaving:leavingPage })
  }
  beginRun()
}

function resetRun() {
  finishRun()
  lanes = createLanes()
  turnGuide = createTurnGuide(exercise.facing)
  renderTurn(null)
  const label = exercise.labels[exercise.rep.metric]
  angleGraph.configure(lanes.map(({ id, color }) => ({ id, color })), [exercise.rep.target, exercise.rep.start])
  graphLegend.textContent = `${lanes.map(lane => `${lane.colorName}: ${laneName(lane)}`).join(' · ')} (smoothed) · ` +
    `Dashed: rep thresholds (${exercise.rep.start}° / ${exercise.rep.target}°).`
  graphCanvas.setAttribute('aria-label', `Live ${label.toLowerCase()} over the last ten seconds, from 0 to 180 degrees. Missing tracking leaves gaps.`)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  lastVideoTime = -1
  clearMeasurements(exercise.startCue)
  beginRun()
}

function applyExercise() {
  const { labels, formRules } = exercise
  title.textContent = `Exercise Tracker · ${exercise.name}`
  for (const toggle of exerciseToggles.children) toggle.setAttribute('aria-pressed', String(toggle.dataset.id === exercise.id))
  instructions.textContent = exercise.instructions
  sideSelect.value = exercise.defaultSide
  graphTitle.textContent = `${labels[exercise.rep.metric]} · last 10 seconds`
  flaggedLabel.hidden = !formRules.length
  rulesLabel.textContent = (formRules.length
    ? `Prototype check: ${list(formRules.map(rule => `${labels[rule.metric].toLowerCase()} ${rule.max !== undefined ? `over ${rule.max}°` : `under ${rule.min}°`} for ${rule.holdMs / 1000} seconds`))} triggers feedback. ` +
      'This checks visible movement features, not overall exercise safety.'
    : 'No form rules for this exercise yet; only reps are counted.') +
    (exercise.tempo ? ` ${exercise.tempo.hint}` : '')
  resetRun()
}

exerciseToggles.addEventListener('click', event => {
  const id = event.target.closest('button')?.dataset.id
  if (!id || id === exercise.id) return
  exercise = exercises.find(profile => profile.id === id)
  applyExercise()
})
sideSelect.addEventListener('change', resetRun)
worldToggle.addEventListener('change', resetRun)
modelSelect.addEventListener('change', () => loadModel(modelSelect.value))
applyExercise()

function releaseFile() {
  if (fileUrl) URL.revokeObjectURL(fileUrl)
  fileUrl = undefined
  video.removeAttribute('src')
  replayButton.disabled = true
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0]
  if (!file) return
  stopCamera()
  releaseFile()
  source = 'file'
  video.controls = true
  stage.classList.add('has-controls')
  resetRun()
  videoName.textContent = file.name
  fileUrl = URL.createObjectURL(file)
  video.src = fileUrl
  video.load()
  status.textContent = 'Loading local video…'
  fileInput.value = ''
})

// The stage takes the video's shape, so the overlay canvas and HUD line up with
// the picture in the page and in full screen alike.
function fitStage() {
  if (video.videoWidth && video.videoHeight) stage.style.setProperty('--aspect', video.videoWidth / video.videoHeight)
}

video.addEventListener('loadedmetadata', () => {
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  fitStage()
  if (source === 'file') {
    replayButton.disabled = false
    status.textContent = 'Video ready. Press Play to analyse it.'
  }
})
video.addEventListener('play', () => {
  if (source !== 'file') return
  cancelAnimationFrame(animationId)
  running = true
  trackPose()
})
video.addEventListener('pause', () => {
  if (source !== 'file') return
  running = false
  cancelAnimationFrame(animationId)
  status.textContent = video.ended ? 'Video finished. Replay to start a new run.' : 'Video paused.'
})
video.addEventListener('ended', () => {
  if (source !== 'file') return
  status.textContent = 'Video finished. Replay to start a new run.'
  finishRun()
})
video.addEventListener('seeking', () => {
  if (source === 'file') resetRun()
})
video.addEventListener('error', () => {
  if (source !== 'file') return
  stopCamera()
  releaseFile()
  status.textContent = 'Could not decode this video. Try an MP4 (H.264) or WebM file.'
})
replayButton.addEventListener('click', async () => {
  resetRun()
  video.currentTime = 0
  try { await video.play() }
  catch (error) { status.textContent = `Playback failed: ${error.message}` }
})

function createModel(variant, delegate) {
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${variant}/float16/1/pose_landmarker_${variant}.task`,
      delegate,
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  })
}

// Switching model mid-run is allowed: frames are skipped until the new one is ready.
async function loadModel(variant) {
  const request = ++modelRequest
  model?.close()
  model = undefined
  modelSelect.disabled = true
  startButton.disabled = true
  fileInput.disabled = true
  status.textContent = `Loading ${variant} pose model…`
  try {
    vision ??= await FilesetResolver.forVisionTasks('/wasm')
    let delegate = 'GPU'
    let next
    try { next = await createModel(variant, delegate) }
    catch {
      delegate = 'CPU'
      next = await createModel(variant, delegate)
    }
    if (request !== modelRequest) { next.close(); return }
    model = next
    status.textContent = running
      ? `Model switched to ${variant} (${delegate}).`
      : `Model ready (${variant}, ${delegate}). Start your camera or open a local video.`
  } catch (error) {
    if (request === modelRequest) status.textContent = `Model failed to load: ${error.message}`
  } finally {
    if (request === modelRequest) {
      modelSelect.disabled = false
      fileInput.disabled = !model
      startButton.disabled = !model || Boolean(stream)
    }
  }
}

startButton.addEventListener('click', async () => {
  stopCamera()
  releaseFile()
  source = 'camera'
  video.controls = false
  stage.classList.remove('has-controls')
  videoName.textContent = 'Webcam mode. Files are processed locally, never uploaded.'
  resetRun()
  const request = ++cameraRequest
  startButton.disabled = true
  fileInput.disabled = true
  status.textContent = 'Starting camera…'

  try {
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    })

    if (request !== cameraRequest) {
      cameraStream.getTracks().forEach(track => track.stop())
      return
    }
    stream = cameraStream
    video.srcObject = stream
    await video.play()
    if (request !== cameraRequest) return
    fileInput.disabled = !model

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    fitStage()

    angleGraph.clear()
    lastVideoTime = -1
    running = true
    stopButton.disabled = false
    trackPose()
  } catch (error) {
    stopCamera()
    status.textContent = `Camera failed: ${error.message}`
  }
})

function drawPose(lane) {
  const { points } = lane
  const warning = lane.assessment.form === 'warning'
  ctx.lineWidth = 5
  for (const [from, to, kind] of exercise.connections) {
    if (!points[from] || !points[to]) continue
    ctx.strokeStyle = kind === 'reference' ? '#94a3b8' : warning ? '#fb923c' : lane.color
    ctx.beginPath()
    ctx.moveTo(points[from].x, points[from].y)
    ctx.lineTo(points[to].x, points[to].y)
    ctx.stroke()
  }
  for (const point of Object.values(points)) {
    ctx.fillStyle = '#facc15'
    ctx.beginPath()
    ctx.arc(point.x, point.y, 8, 0, Math.PI * 2)
    ctx.fill()
  }
}

function trackLane(lane, landmarks, worldLandmarks, now) {
  if (lane.side === 'auto') {
    const side = chooseSide(landmarks, exercise, lane.current)
    if (side !== lane.current) {
      // A different leg or arm is a different movement history.
      lane.current = side
      lane.tracker.resetSequence()
      lane.smoother.reset()
      lane.pointSmoother.reset()
    }
  }
  lane.hidden = lane.current ? hiddenJoints(landmarks, lane.current, exercise) : jointNames()
  lane.measurement = lane.current
    ? measurePose(landmarks, lane.current, canvas.width, canvas.height, exercise, worldLandmarks)
    : null
  lane.metrics = lane.smoother.smooth(lane.measurement?.metrics, now)
  lane.points = lane.pointSmoother.smooth(lane.measurement?.points, now)
  lane.assessment = lane.tracker.update(lane.metrics, now)
}

function trackPose() {
  if (!running) return

  try {
    if (model && !video.seeking && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime
      const result = model.detectForVideo(video, performance.now())

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      // Exercise timing follows the clip, independent of playback speed or pauses.
      const now = source === 'file' ? video.currentTime * 1000 : performance.now()
      const worldLandmarks = worldToggle.checked ? result.worldLandmarks[0] : undefined
      renderTurn(turnGuide.update(bodyTurn(result.worldLandmarks[0]) ?? bodyTurn(result.landmarks[0]), now))
      for (const lane of lanes) trackLane(lane, result.landmarks[0], worldLandmarks, now)
      if (lanes.some(lane => lane.metrics)) {
        run.startedAt ??= Date.now()
        run.endedAt = Date.now()
      }
      angleGraph.add(now, Object.fromEntries(lanes.map(lane => [lane.id, lane.metrics?.[exercise.rep.metric]])))
      renderMeasurements()
      renderForm()
      renderRepFeedback()

      const tracked = lanes.filter(lane => lane.measurement)
      for (const lane of tracked) drawPose(lane)
      const blocked = lanes.filter(lane => lane.hidden.length)
      if (tracked.length) {
        const space = tracked[0].measurement.space === '3d' ? '3D' : '2D'
        const auto = lanes[0].side === 'auto' ? ` Following ${lanes[0].current} side.` : ''
        status.textContent = (source === 'file' ? `Analysing local video (${space} angles).` : `Tracking (${space} angles).`) + auto +
          (blocked.length ? ` Not visible: ${hiddenText(blocked)}.` : '')
      } else {
        status.textContent = `Reposition — not visible: ${hiddenText(blocked)}.`
      }
    }

    animationId = requestAnimationFrame(trackPose)
  } catch (error) {
    stopCamera()
    status.textContent = `Tracking failed: ${error.message}`
  }
}

function stopCamera() {
  cameraRequest++
  video.pause()
  for (const lane of lanes) {
    lane.tracker.resetSequence()
    lane.smoother.reset()
    lane.pointSmoother.reset()
  }
  running = false
  cancelAnimationFrame(animationId)
  finishRun()
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  video.srcObject = null
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  fileInput.disabled = !model
  startButton.disabled = !model
  stopButton.disabled = true
  clearMeasurements('Form check paused.')
  renderTurn(null)
  status.textContent = 'Camera stopped.'
}

// Real full screen where the browser allows it on an element; otherwise (iPhone
// Safari) the container is pinned over the page with CSS instead.
const fullscreenElement = () => document.fullscreenElement ?? document.webkitFullscreenElement
function setImmersive(on) {
  cameraContainer.classList.toggle('immersive', on)
  document.body.classList.toggle('no-scroll', on)
  syncFullscreenButton()
}
function syncFullscreenButton() {
  const on = Boolean(fullscreenElement()) || cameraContainer.classList.contains('immersive')
  fullscreenButton.textContent = on ? 'Exit full screen' : 'Full screen'
  fullscreenButton.setAttribute('aria-pressed', String(on))
}
fullscreenButton.addEventListener('click', async () => {
  if (fullscreenElement()) {
    await (document.exitFullscreen ?? document.webkitExitFullscreen).call(document)
  } else if (cameraContainer.classList.contains('immersive')) {
    setImmersive(false)
  } else {
    const request = cameraContainer.requestFullscreen ?? cameraContainer.webkitRequestFullscreen
    try {
      if (!request) throw new Error('unsupported')
      await request.call(cameraContainer)
    } catch {
      setImmersive(true)
    }
  }
})
document.addEventListener('fullscreenchange', syncFullscreenButton)
document.addEventListener('webkitfullscreenchange', syncFullscreenButton)
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && cameraContainer.classList.contains('immersive')) setImmersive(false)
})

stopButton.addEventListener('click', stopCamera)
window.addEventListener('pagehide', () => { leavingPage = true; stopCamera(); releaseFile() })
window.addEventListener('pageshow', () => { leavingPage = false })
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (source === 'file') video.pause()
    else stopCamera()
  }
})

loadModel(modelSelect.value)
