import './style.css'
import { createAccount } from './account.js'
import { createAskWidget } from './ask-widget.js'
import { createAngleGraph } from './angle-graph.js'
import { exercises } from './exercises.js'
import { bodyTurn, createSideChooser, createTracker, createTurnGuide, hiddenJoints, measurePose } from './exercise-tracker.js'
import { buildSessionRecord, newRunId } from './session-record.js'
import { createMetricSmoother, createPointSmoother } from './smoothing.js'
import { COMMANDS, bluetoothUnavailable, createImuLink } from './imu.js'
import { createVbt } from './vbt.js'
import { SAFETY_LABELS, bodyFrame, createSafetyMonitor } from './safety.js'
import { createClipPlanner } from './clip-planner.js'
import { createRecorder, recordingSupported } from './recorder.js'
import { createRecordingsPanel } from './recordings-panel.js'
import { saveRecording } from './device-store.js'
import { themeSwitch } from './theme.js'
import { createPlanGuide } from './plan-guide.js'
import {
  PoseLandmarker,
  FilesetResolver,
} from '@mediapipe/tasks-vision'

let exercise = exercises[0]
let lanes = []
// Velocity loss from the fastest rep at which the sensor suggests ending the set.
const LOSS_THRESHOLD = 25

// The everyday screen is deliberately small: pick an exercise, press Start, follow the
// one message under the picture. Everything marked "diagnostic" (settings, sensor
// set-up, test videos, raw readouts, the graph) shows only while Show details is on.
document.querySelector('#app').innerHTML = `
  <header class="topbar">
    <a class="brand" href="#">
      <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5v11M3.5 9v6M17.5 6.5v11M20.5 9v6M6.5 12h11"/></svg>
      Exercise Tracker
    </a>
    <div class="topbar-end">
      <nav id="account-bar" class="account-bar" aria-label="Account"></nav>
      <span id="theme-slot"></span>
    </div>
  </header>
  <main id="account-view" hidden></main>
  <div id="tracker-view">
  <section class="hero" aria-labelledby="title">
    <span id="exercise-label" class="eyebrow">Choose your exercise</span>
    <div id="exercise" class="toggle-group exercise-buttons" role="group" aria-labelledby="exercise-label">
      ${exercises.map(profile => `<button type="button" data-id="${profile.id}" aria-pressed="false">${profile.name}</button>`).join('')}
    </div>
    <h1 id="title">Exercise Tracker</h1>
    <p id="instructions" class="instructions"></p>
    <p id="plan-note" class="plan-note" role="status" hidden></p>
    <div class="controls">
      <button id="start" class="big-button start-button" disabled>Start</button>
      <button id="stop" class="big-button stop-button" hidden>Stop</button>
    </div>
  </section>

  <div class="camera-container" id="camera-container">
    <div class="stage" id="stage" data-running="false">
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
          <p id="plan-sets" class="hud-sets" hidden></p>
          <div class="hud-details diagnostic">
            <p id="angle"></p>
            <p id="metrics"></p>
            <p id="rep-counts"></p>
            <p id="flagged"></p>
            <p id="sensor-stats"></p>
          </div>
        </div>
        <div class="hud-bottom">
          <div id="plan-cue" class="plan-cue" role="status" hidden></div>
          <p id="turn" class="hud-turn" role="status" hidden></p>
          <p id="coach" class="hud-message simple-only" data-state="unassessable" role="status"></p>
        </div>
      </div>
      <div id="safety-alert" class="safety-alert" role="alert" hidden>
        <p id="safety-message"></p>
        <button id="safety-ok" type="button" class="big-button">I'm OK</button>
      </div>
    </div>
    <aside class="feedback-panel diagnostic" aria-labelledby="feedback-title">
      <h2 id="feedback-title" class="eyebrow">Feedback</h2>
      <p id="rep-feedback" class="hud-message" data-state="unassessable" role="status"></p>
      <p id="form" class="hud-message" data-state="unassessable" role="status">Form check waiting for camera.</p>
      <p id="sensor-feedback" class="hud-message" data-state="within" role="status"></p>
    </aside>
  </div>

  <p id="save-status" class="hint save-status" role="status"></p>

  <div class="preferences">
    <label class="switch"><input id="speak" type="checkbox" checked> Speak set cues and safety warnings out loud</label>
    <label class="switch"><input id="details-toggle" type="checkbox" checked> Show details</label>
    <label class="switch"><input id="keep-recordings" type="checkbox" checked> Keep recordings on this device</label>
  </div>

  <section id="recordings" class="card recordings" aria-labelledby="recordings-title" hidden></section>

  <div id="details" class="diagnostic details-grid">
  <section class="card settings" aria-labelledby="tracking-title">
    <h2 id="tracking-title">Tracking</h2>
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
    <label class="switch"><input id="world" type="checkbox" checked> 3D angles</label>
    <p class="hint">3D angles use MediaPipe's depth estimate, so they stay accurate when you are not
    exactly side-on or face-on. Untick to measure flat image angles instead.</p>
  </section>

  <section class="card settings sensor-panel" aria-labelledby="sensor-title">
    <h2 id="sensor-title">Dumbbell sensor</h2>
    <p id="sensor-status" class="hint" role="status"></p>
    <div class="button-row">
      <button id="sensor-connect" type="button">Connect sensor</button>
      <button id="sensor-gyro" type="button" class="secondary" disabled>Calibrate gyro</button>
      <button id="sensor-accel" type="button" class="secondary" disabled>Calibrate accelerometer</button>
    </div>
    <label>Dumbbell weight (kg): <input id="sensor-mass" type="number" min="0.5" max="200" step="0.5" inputmode="decimal" placeholder="e.g. 5"></label>
    <label>
      Sensor in:
      <select id="sensor-hand">
        <option value="">Not specified</option>
        <option value="left">Left hand</option>
        <option value="right">Right hand</option>
      </select>
    </label>
    <p class="hint">While the camera runs, the sensor measures lifting speed, range and power for each rep.
    A speed drop of more than ${LOSS_THRESHOLD}% from the fastest rep is a sign of fatigue. Enter the weight to get power.</p>
  </section>

  <section class="card video-input" aria-labelledby="video-title">
    <h2 id="video-title">Test video</h2>
    <label>Open a local video <input id="video-file" type="file" accept="video/*" disabled></label>
    <p id="video-name" class="hint">No video selected. Files are processed locally, never uploaded.</p>
    <button id="replay" class="secondary" disabled>Replay from start</button>
    <p class="hint"><a href="/benchmark.html">Open the pose benchmark</a> to compare Full and Lite model
    measurements on a local clip.</p>
  </section>

  <section class="card angle-chart" aria-labelledby="graph-title">
    <h2 id="graph-title"></h2>
    <canvas id="angle-graph" role="img"></canvas>
    <p class="hint"><span id="graph-legend"></span><br>
    Gaps mean tracking is unavailable. The graph pauses when playback or the camera stops.</p>
  </section>

  <p id="rules" class="hint"></p>
  </div>
  </div>
`

document.querySelector('#theme-slot').replaceWith(themeSwitch())
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
const trackerView = document.querySelector('#tracker-view')
const coachLabel = document.querySelector('#coach')
const safetyAlert = document.querySelector('#safety-alert')
const safetyMessage = document.querySelector('#safety-message')
const safetyOk = document.querySelector('#safety-ok')
const speakToggle = document.querySelector('#speak')
const detailsToggle = document.querySelector('#details-toggle')
const keepRecordingsToggle = document.querySelector('#keep-recordings')
const recordingsPanel = createRecordingsPanel(document.querySelector('#recordings'))
// "Ask your coach" over the camera picture; it reuses the tracker's camera while it runs.
const askWidget = createAskWidget({ stage, cameraTrack:() => stream?.getVideoTracks()[0] ?? null })
// A signed-in patient's plan: today's exercises, sets and rests (src/plan-guide.js).
const planGuide = createPlanGuide({
  picker:exerciseToggles,
  note:document.querySelector('#plan-note'),
  setsLabel:document.querySelector('#plan-sets'),
  panel:document.querySelector('#plan-cue'),
  speak:text => speak(text, false, { interrupt:false }),
  onPick:id => chooseExercise(id),
})
const account = createAccount({
  bar:document.querySelector('#account-bar'),
  view:document.querySelector('#account-view'),
  trackerView,
  saveStatus:document.querySelector('#save-status'),
  onLeaveTracker:() => { stopCamera(); askWidget.stop() },
  onCoaches:coaches => askWidget.setCoaches(coaches),
  onUser:(user, queued) => planGuide.setUser(user, queued),
  onOutbox:event => planGuide.outbox(event),
  onShowTracker:() => { planGuide.load(); chooseFromAddress() },
})

// Dumbbell sensor: connection, calibration and the live readout. Its reps are only
// analysed while the camera runs, so they belong to the same run as the camera's.
const sensorStatus = document.querySelector('#sensor-status')
const sensorConnect = document.querySelector('#sensor-connect')
const sensorGyro = document.querySelector('#sensor-gyro')
const sensorAccel = document.querySelector('#sensor-accel')
const sensorMassInput = document.querySelector('#sensor-mass')
const sensorHand = document.querySelector('#sensor-hand')
const sensorFeedback = document.querySelector('#sensor-feedback')
const sensorStats = document.querySelector('#sensor-stats')
const sensor = {
  state:'disconnected', name:null, info:null, packet:null, error:null, note:null,
  calibration:null, lastRep:null, fatigued:false, connecting:false,
}
let vbt

const SETTINGS_KEY = 'exercise-tracker:sensor'
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
  if (Number.isFinite(saved.massKg)) sensorMassInput.value = saved.massKg
  if (['', 'left', 'right'].includes(saved.hand)) sensorHand.value = saved.hand
} catch {}

// Show details and spoken warnings are per-device preferences; details start on.
const PREFERENCES_KEY = 'exercise-tracker:preferences'
try {
  const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}')
  if (typeof saved.details === 'boolean') detailsToggle.checked = saved.details
  if (typeof saved.speak === 'boolean') speakToggle.checked = saved.speak
  if (typeof saved.keepRecordings === 'boolean') keepRecordingsToggle.checked = saved.keepRecordings
} catch {}
function applyPreferences() {
  trackerView.classList.toggle('simple', !detailsToggle.checked)
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ details:detailsToggle.checked, speak:speakToggle.checked, keepRecordings:keepRecordingsToggle.checked }))
  } catch {}
}
keepRecordingsToggle.addEventListener('change', applyPreferences)
if (!recordingSupported()) {
  keepRecordingsToggle.disabled = true
  keepRecordingsToggle.parentElement.title = 'This browser cannot record video (no WebCodecs support).'
}
detailsToggle.addEventListener('change', applyPreferences)
speakToggle.addEventListener('change', () => {
  applyPreferences()
  if (!speakToggle.checked) window.speechSynthesis?.cancel()
})
applyPreferences()

function sensorMass() {
  const value = sensorMassInput.valueAsNumber
  return Number.isFinite(value) && value >= 0.5 && value <= 200 ? value : null
}

const sensorLink = createImuLink({
  onState(event) {
    sensor.state = event.state
    sensor.name = event.device
    sensor.info = event.info
    if (event.error) sensor.error = event.error.message
    else if (event.state === 'connected') sensor.error = null
    if (event.state !== 'connected') sensor.packet = null
    renderSensor()
  },
  onPacket(packet) {
    sensor.packet = packet
    followCalibration(packet)
    if (running && source === 'camera') {
      for (const sample of packet.samples) {
        for (const alert of safety.imu(sample, performance.now())) showSafety(alert)
        for (const event of vbt.push(sample)) {
          sensor.lastRep = event.rep
          sensor.fatigued = event.fatigued
          run.startedAt ??= Date.now()
          run.endedAt = Date.now()
        }
      }
    }
    renderSensor()
  },
})

// The firmware reports calibration through header fields; this turns them into messages.
function followCalibration(packet) {
  const calibration = sensor.calibration
  if (!calibration) return
  const done = (note, state) => {
    sensor.calibration = null
    sensor.note = { text:note, state, at:Date.now() }
    sensorLink.readInfo().then(info => { sensor.info = info; renderSensor() })
  }
  if (calibration.kind === 'gyro') {
    if (packet.gyroCalCount !== calibration.count) done('Gyro calibrated.', 'within')
    else if (!packet.has('calibrating') && Date.now() - calibration.since > 1000) {
      done('Gyro calibration timed out: set the dumbbell down on a steady surface and keep it completely still, then try again.', 'warning')
    }
  } else if (Date.now() - calibration.since < 500) {
    // Packets sent before the command arrived still carry the previous calibration's result.
  } else if (packet.accelState === 'done') done('Accelerometer calibrated and saved on the sensor.', 'within')
  else if (packet.accelState === 'failed') {
    done('Accelerometer calibration failed: hold each side perfectly still, and include all six sides. Try again.', 'warning')
  } else if (packet.accelState === 'idle' && Date.now() - calibration.since > 1000) {
    done('Accelerometer calibration cancelled.', '')
  }
}

function sensorHealth(packet) {
  if (packet.has('linkTooSmall')) return 'This Bluetooth connection cannot carry sensor data (MTU too small). Use Chrome on a computer, or update Android.'
  if (packet.has('sensorError')) return 'The sensor board cannot read its MPU6050: check the wiring (SDA, SCL, 3V3, GND).'
  if (sensor.calibration?.kind === 'gyro' || packet.has('calibrating')) return 'Calibrating gyro: set the dumbbell down and keep it still.'
  if (sensor.calibration?.kind === 'accel') {
    return `Accelerometer calibration: ${packet.accelPoses} of 6+ positions captured. Rest it still for 2 seconds on each side in turn (top, bottom, left, right, front, back).`
  }
  if (!packet.has('gyroReady')) return 'Set the dumbbell down still for a second so the sensor can calibrate.'
  return null
}

function renderSensor() {
  const unavailable = bluetoothUnavailable()
  const connected = sensor.state === 'connected'
  const packet = sensor.packet
  let text
  if (unavailable) text = unavailable
  else if (sensor.state === 'connecting') text = 'Connecting to the sensor…'
  else if (sensor.state === 'reconnecting') text = `Connection lost. Reconnecting to ${sensor.name}…`
  else if (!connected) text = sensor.error ?? 'Not connected. Switch the sensor on (its light breathes blue) and press Connect sensor.'
  else if (!packet) text = `Connected to ${sensor.name}. Waiting for data…`
  else {
    const health = sensorHealth(packet)
    const parts = [`${sensor.name} · ${packet.tempC.toFixed(1)} °C.`]
    if (health) parts.push(health)
    else {
      if (!packet.has('accelCalibrated')) parts.push('Accelerometer not calibrated yet, so speeds are less accurate.')
      parts.push(running && source === 'camera' ? 'Recording reps.' : 'Start the camera to record reps.')
      const lost = vbt.report().interruptions
      if (lost) parts.push(`Data dropped ${lost === 1 ? 'once' : `${lost} times`}; a rep may be missing.`)
    }
    text = parts.join(' ')
  }
  // Outcome notes (calibrated, failed, cancelled) fade after a few seconds.
  if (sensor.note && Date.now() - sensor.note.at > 8000 && !sensor.note.sticky) sensor.note = null
  if (sensor.note && connected) text = `${sensor.note.text} ${text}`
  setText(sensorStatus, text)
  sensorStatus.dataset.state = sensor.note?.state ?? ''

  sensorConnect.disabled = Boolean(unavailable) || sensor.connecting || sensor.state === 'connecting'
  setText(sensorConnect, connected || sensor.state === 'reconnecting' ? 'Disconnect sensor' : sensor.connecting ? 'Connecting…' : 'Connect sensor')
  const calibrating = Boolean(sensor.calibration)
  sensorGyro.disabled = !packet || calibrating
  sensorAccel.disabled = !packet || sensor.calibration?.kind === 'gyro'
  setText(sensorAccel, sensor.calibration?.kind === 'accel' ? 'Cancel accelerometer calibration' : 'Calibrate accelerometer')

  const reps = vbt?.report().reps.length ?? 0
  sensorStats.hidden = !connected
  setText(sensorStats, connected ? `Sensor reps: ${reps}` : '')
  const rep = sensor.lastRep
  if (!rep) {
    setText(sensorFeedback, '')
    return
  }
  const power = rep.meanPowerW === null ? '' : ` · ${Math.round(rep.meanPowerW)} W`
  const drop = rep.number > 1 ? ` · speed drop ${Math.round(rep.velocityLossPct)}%` : ''
  sensorFeedback.dataset.state = sensor.fatigued ? 'warning' : 'within'
  setText(sensorFeedback, `Sensor rep ${rep.number}: ${rep.mcv.toFixed(2)} m/s · ${Math.round(rep.romCm)} cm${power}${drop}` +
    (sensor.fatigued ? `. Speed is down more than ${LOSS_THRESHOLD}% from your fastest rep: consider ending the set.` : ''))
}

async function sensorCommand(command, calibration) {
  try {
    await sensorLink.send(command)
    sensor.note = null
    sensor.calibration = calibration && { ...calibration, since:Date.now(), count:sensor.packet?.gyroCalCount }
  } catch (error) {
    sensor.note = { text:`Could not reach the sensor: ${error.message}`, state:'warning', at:Date.now() }
  }
  renderSensor()
}

sensorConnect.addEventListener('click', async () => {
  if (sensor.state === 'connected' || sensor.state === 'reconnecting') return sensorLink.disconnect()
  sensor.connecting = true
  sensor.error = null
  sensor.note = null
  renderSensor()
  try { await sensorLink.connect() }
  catch (error) { sensor.error = error.message }
  finally {
    sensor.connecting = false
    renderSensor()
  }
})
sensorGyro.addEventListener('click', () => sensorCommand(COMMANDS.calibrateGyro, { kind:'gyro' }))
sensorAccel.addEventListener('click', () => sensor.calibration?.kind === 'accel'
  ? sensorCommand(COMMANDS.cancel, null).then(() => { sensor.note = { text:'Accelerometer calibration cancelled.', state:'', at:Date.now() }; renderSensor() })
  : sensorCommand(COMMANDS.calibrateAccel, { kind:'accel' }))

// Weight and hand describe the run, so a change closes the current one (and saves it).
function sensorSettingsChanged() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ massKg:sensorMass(), hand:sensorHand.value })) } catch {}
  if (sensorMassInput.value && sensorMass() === null) {
    sensor.note = { text:'Weight must be between 0.5 and 200 kg; power is left out until it is.', state:'warning', at:Date.now(), sticky:true }
  } else if (sensor.note?.text.startsWith('Weight')) sensor.note = null
  finishRun()
  renderSensor()
}
sensorMassInput.addEventListener('change', sensorSettingsChanged)
sensorHand.addEventListener('change', sensorSettingsChanged)

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
// Per limb: a light colour for the camera picture (always dark), and the CSS variable
// of its line on the angle graph, which follows the page theme (src/style.css --lane-*).
const LANE_COLORS = [['#0fb5d4', '--lane-1-ink'], ['#ec5c9e', '--lane-2-ink']]
// Overlay colours on the camera picture, from the fixed tokens in src/style.css.
const OVERLAY = { reference:'#dccdbd', warning:'#ffa77d', joint:'#f2b705', jointRing:'#2d2016' }
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
    color: LANE_COLORS[index][0],
    ink: LANE_COLORS[index][1],
    tracker: createTracker(exercise),
    sideChooser: createSideChooser(exercise),
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

// The single plain-language message shown while details are hidden: the most
// important thing to fix first, then encouragement.
function laneCoach(lane) {
  const { form, messages, tempoMessage, waiting, lastRep } = lane.assessment
  if (form === 'warning') return { state:'warning', text:messages.join(' ') }
  if (!lane.measurement) return { state:'unassessable' }
  if (tempoMessage) return { state:'warning', text:tempoMessage }
  if (waiting) return { state:'pending', text:exercise.startCue }
  if (!lastRep) return { state:'pending', text:'Off you go: start your first rep.' }
  if (lastRep.kind === 'partial' || lastRep.tempo === 'fast' || lastRep.tempo === 'slow') return { state:'warning', text:lastRep.messages.join(' ') }
  return { state:'within', text:'Good rep! Keep going.' }
}

function renderCoach() {
  const items = lanes.map(lane => ({ lane, ...laneCoach(lane) }))
  let state = ['warning', 'unassessable', 'pending', 'within'].find(form => items.some(item => item.state === form))
  // Warnings name their side when both are tracked; other messages read the same for both.
  const prefix = item => lanes.length > 1 && item.state === 'warning' ? `${laneName(item.lane)}: ` : ''
  let text = [...new Set(items.filter(item => item.state === state).map(item => prefix(item) + item.text))].join(' ')
  if (state === 'unassessable') {
    // Nobody in view reads as one instruction; otherwise name just the missing joints.
    const blocked = items.filter(item => item.state === 'unassessable').map(item => item.lane)
    const nobody = !lanes.some(lane => lane.measurement) && blocked.every(lane => !lane.hidden.length || lane.hidden.length === jointNames().length)
    const missing = blocked.filter(lane => lane.hidden.length)
    text = nobody ? 'Step into the picture so the camera can see you.'
      : missing.length ? `Move so the camera can see your ${hiddenText(missing)}.` : 'Stand where the camera can see you clearly.'
  }
  if (state === 'within' && sensor.fatigued) {
    state = 'warning'
    text = 'Your lifts are slowing down. Time for a rest.'
  }
  // Resting or finished: the plan's box says what to do, so encouragement would contradict it.
  if ((state === 'within' || state === 'pending') && planGuide.quiet()) text = ''
  coachLabel.dataset.state = state
  setText(coachLabel, text)
}

function setRunning(on) {
  running = on
  stage.dataset.running = String(on)
}

// One big button at a time: Start while idle, Stop while the camera runs.
function syncControls() {
  startButton.hidden = Boolean(stream)
  stopButton.hidden = !stream
  startButton.disabled = !model
}

// Safety alerts: a caution clears itself after a few seconds; a possible fall stays
// until the person taps I'm OK. Every alert is kept with the run for the coach.
const CAUTION_MS = 6000
const MAX_RUN_ALERTS = 200
let shownAlert = null
let alertTimer
let audio

function showSafety(alert) {
  if (run.safety.length < MAX_RUN_ALERTS) run.safety.push({ kind:alert.kind, at:Date.now() })
  markClip({ kind:'safety', lane:null, rep:null, text:SAFETY_LABELS[alert.kind] ?? alert.kind, at:performance.now() })
  run.startedAt ??= Date.now()
  run.endedAt = Date.now()
  // A possible fall is never covered up by a lesser warning.
  if (shownAlert?.severity === 'danger' && alert.severity !== 'danger') return
  shownAlert = alert
  safetyAlert.dataset.severity = alert.severity
  safetyMessage.textContent = alert.message
  safetyOk.hidden = alert.severity !== 'danger'
  safetyAlert.hidden = false
  clearTimeout(alertTimer)
  if (alert.severity !== 'danger') alertTimer = setTimeout(hideSafety, CAUTION_MS)
  speak(alert.message, alert.severity === 'danger')
}

function hideSafety() {
  clearTimeout(alertTimer)
  shownAlert = null
  safetyAlert.hidden = true
}
safetyOk.addEventListener('click', () => {
  hideSafety()
  window.speechSynthesis?.cancel()
})

// Warnings are read aloud, since the person is watching their body, not the screen.
// Set cues wait their turn (interrupt false) rather than cut off a safety warning.
function speak(text, urgent, { interrupt = true } = {}) {
  if (!speakToggle.checked) return
  if (urgent) beep()
  const synth = window.speechSynthesis
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return
  if (interrupt) synth.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = 0.9
  synth.speak(utterance)
}

function beep() {
  try {
    const tone = audio.createOscillator()
    const gain = audio.createGain()
    tone.frequency.value = 880
    gain.gain.value = 0.2
    tone.connect(gain).connect(audio.destination)
    tone.start()
    tone.stop(audio.currentTime + 0.4)
  } catch {}
}

// Browsers only allow sound and speech that start from a tap, so Start unlocks both.
function unlockSound() {
  try {
    audio ??= new AudioContext()
    audio.resume()
  } catch {}
  const synth = window.speechSynthesis
  if (synth && typeof SpeechSynthesisUtterance !== 'undefined' && !synth.speaking) {
    const silent = new SpeechSynthesisUtterance(' ')
    silent.volume = 0
    synth.speak(silent)
  }
}

let turnGuide
let safety
// The run being recorded. Settings are captured when it begins, because the
// controls already show the new values by the time the old run is finished.
let run
let leavingPage = false

function beginRun() {
  run = {
    id:newRunId(), exercise, source:source === 'file' ? 'video' : 'camera',
    side:sideSelect.value, angles:worldToggle.checked ? '3d' : '2d', startedAt:null, endedAt:null, safety:[],
  }
  vbt = createVbt({ massKg:sensorMass(), loadStart:exercise.loadStart, lossThresholdPct:LOSS_THRESHOLD })
  sensor.lastRep = null
  sensor.fatigued = false
}

// The sensor's reps for the run that is ending, with what is needed to read them later.
function sensorReport() {
  vbt.finish()
  const report = vbt.report()
  if (!report.reps.length) return null
  return { ...report, hand:sensorHand.value || null, sensor:{ name:sensor.name, firmware:sensor.info?.firmware ?? null } }
}

// Hands the run that is ending to the account for saving, then starts a fresh one.
function finishRun() {
  if (!run) return
  let record = null
  if (run.startedAt) {
    for (const lane of lanes) lane.tracker.resetSequence()
    record = buildSessionRecord({ ...run, lanes, imu:sensorReport() })
    account.saveSession(record, { leaving:leavingPage })
  }
  if (run.recording) finishRecording(run, record)
  beginRun()
  if (stream && running) startRecording()
}

// Recording: camera runs only (a local video file already is a recording). The
// encoder starts asynchronously, so frames before it is ready are not recorded.
// Clips are made only for a signed-in patient sharing clips with a coach; the full
// recording only when "Keep recordings on this device" is on.
const toEpoch = ms => performance.timeOrigin + ms
function startRecording() {
  const keepFull = keepRecordingsToggle.checked
  if (!recordingSupported() || source !== 'camera' || (!keepFull && !account.clipsWanted())) return
  const recording = { planner:createClipPlanner(), clips:[], recorder:null, closed:false, startedAt:Date.now(), exercise:run.exercise }
  run.recording = recording
  recording.ready = createRecorder({
    width:video.videoWidth, height:video.videoHeight, keepFull,
    onError:error => { status.textContent = `Recording stopped: ${error.message}` },
  }).then(recorder => {
    if (recording.closed) { recorder?.close(); return null }
    recording.recorder = recorder
    return recorder
  }, () => null)
}

function markClip(event) {
  if (run?.recording && account.clipsWanted()) run.recording.planner.mark(event)
}

function cutClips(recording, plans) {
  for (const plan of plans) {
    const clip = recording.recorder.clip(plan.start, plan.end)
    if (!clip) continue
    recording.clips.push({
      id:newRunId(), blob:clip.blob, type:clip.blob.type, startedAt:Math.round(toEpoch(clip.start)), durationMs:Math.round(clip.durationMs),
      labels:plan.labels.map(label => ({ ...label, at:Math.round(toEpoch(label.at)) })),
    })
  }
}

async function finishRecording(finished, record) {
  const recording = finished.recording
  recording.closed = true
  const recorder = await recording.ready
  if (!recorder) return
  try {
    await recorder.flush()
    cutClips(recording, recording.planner.flush())
    const full = recorder.finish()
    // Clips belong to the saved session; a run with nothing to save has no clips to share.
    if (record && recording.clips.length) account.saveClips(record.id, recording.clips)
    if (full) {
      await saveRecording({ id:finished.id, startedAt:recording.startedAt, exercise:recording.exercise.id,
        durationMs:Math.round(full.durationMs), type:full.blob.type, blob:full.blob })
      recordingsPanel.refresh()
    }
  } catch (error) {
    recorder.close()
    status.textContent = `Could not keep the recording: ${error.message}`
  }
}

function resetRun() {
  finishRun()
  lanes = createLanes()
  turnGuide = createTurnGuide(exercise.facing)
  safety = createSafetyMonitor(exercise)
  renderTurn(null)
  const label = exercise.labels[exercise.rep.metric]
  angleGraph.configure(lanes.map(({ id, ink }) => ({ id, color:ink })), [exercise.rep.target, exercise.rep.start])
  graphLegend.replaceChildren(...lanes.flatMap((lane, index) => {
    const swatch = document.createElement('span')
    swatch.className = 'legend-swatch'
    swatch.style.background = `var(${lane.ink})`
    return [index ? ' · ' : '', swatch, laneName(lane)]
  }), ` (smoothed) · Dashed: rep thresholds (${exercise.rep.start}° / ${exercise.rep.target}°).`)
  graphCanvas.setAttribute('aria-label', `Live ${label.toLowerCase()} over the last ten seconds, from 0 to 180 degrees. Missing tracking leaves gaps.`)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  lastVideoTime = -1
  clearMeasurements(exercise.startCue)
  beginRun()
}

function applyExercise() {
  const { labels, formRules } = exercise
  title.textContent = exercise.name
  for (const toggle of exerciseToggles.querySelectorAll('button[data-id]')) toggle.setAttribute('aria-pressed', String(toggle.dataset.id === exercise.id))
  planGuide.select(exercise.id)
  instructions.textContent = exercise.instructions
  sideSelect.value = exercise.defaultSide
  graphTitle.textContent = `${labels[exercise.rep.metric]} · last 10 seconds`
  flaggedLabel.hidden = !formRules.length
  rulesLabel.textContent = (formRules.length
    ? `Prototype check: ${list(formRules.map(rule => `${labels[rule.metric].toLowerCase()} ${rule.max !== undefined ? `over ${rule.max}°` : `under ${rule.min}°`} for ${rule.holdMs / 1000} seconds`))} triggers feedback. ` +
      'Form checks look at visible movement features only.'
    : 'No form rules for this exercise yet; only reps are counted.') +
    (exercise.tempo ? ` ${exercise.tempo.hint}` : '') +
    ' Safety alerts watch for sudden drops, falls, leaning off balance, jerky movements and a dropped dumbbell. ' +
    'They are prototype checks, not a medical fall detector.'
  resetRun()
}

function chooseExercise(id) {
  const next = exercises.find(profile => profile.id === id)
  if (!next || next === exercise) return
  exercise = next
  applyExercise()
}
exerciseToggles.addEventListener('click', event => chooseExercise(event.target.closest('button')?.dataset.id))
// "Start" on the plan calendar links to #?exercise=<id>.
function chooseFromAddress() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '')
  if (location.hash.replace(/^#\/?/, '').split('?')[0] === '' && params.has('exercise')) chooseExercise(params.get('exercise'))
}
window.addEventListener('hashchange', chooseFromAddress)
sideSelect.addEventListener('change', resetRun)
worldToggle.addEventListener('change', resetRun)
modelSelect.addEventListener('change', () => loadModel(modelSelect.value))
applyExercise()
chooseFromAddress()

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
  setRunning(true)
  trackPose()
})
video.addEventListener('pause', () => {
  if (source !== 'file') return
  setRunning(false)
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
      : `Ready. Press Start to begin. (Pose model: ${variant}, ${delegate}.)`
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
  unlockSound()
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
    setRunning(true)
    planGuide.start()
    syncControls()
    startRecording()
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
    ctx.strokeStyle = kind === 'reference' ? OVERLAY.reference : warning ? OVERLAY.warning : lane.color
    // The reference line is dashed so it reads apart from a pale limb line by shape too.
    ctx.setLineDash(kind === 'reference' ? [10, 8] : [])
    ctx.beginPath()
    ctx.moveTo(points[from].x, points[from].y)
    ctx.lineTo(points[to].x, points[to].y)
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.fillStyle = OVERLAY.joint
  ctx.strokeStyle = OVERLAY.jointRing
  ctx.lineWidth = 3
  for (const point of Object.values(points)) {
    ctx.beginPath()
    ctx.arc(point.x, point.y, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
}

function trackLane(lane, landmarks, worldLandmarks, now) {
  if (lane.side === 'auto') {
    const side = lane.sideChooser.update(landmarks, worldLandmarks, now, canvas.width, canvas.height, lane.current)
    if (side !== lane.current) {
      // A different leg or arm is a different movement history.
      lane.current = side
      lane.tracker.resetSequence()
      lane.smoother.reset()
      lane.pointSmoother.reset()
      for (const { at, value } of lane.sideChooser.recent(side)) lane.tracker.update({ [exercise.rep.metric]:value }, at)
    }
  }
  lane.hidden = lane.current ? hiddenJoints(landmarks, lane.current, exercise) : jointNames()
  lane.measurement = lane.current
    ? measurePose(landmarks, lane.current, canvas.width, canvas.height, exercise, worldLandmarks)
    : null
  lane.metrics = lane.smoother.smooth(lane.measurement?.metrics, now)
  lane.points = lane.pointSmoother.smooth(lane.measurement?.points, now)
  lane.assessment = lane.tracker.update(lane.metrics, now)
  noteClipEvents(lane, now)
}

// Form warnings clip from when they start; tempo problems once the rep is judged,
// reaching back to the start of its lift.
function noteClipEvents(lane, now) {
  const { form, messages, reps, lastRep } = lane.assessment
  if (form === 'warning' && lane.lastForm !== 'warning') {
    markClip({ kind:'form', lane:lane.id, rep:reps + 1, text:messages[0], at:now })
  }
  lane.lastForm = form
  if (lastRep && lastRep !== lane.lastRep) {
    lane.lastRep = lastRep
    if (lastRep.kind === 'full' && (lastRep.tempo === 'fast' || lastRep.tempo === 'slow')) {
      markClip({ kind:'tempo', lane:lane.id, rep:lastRep.number, text:lastRep.messages[0] ?? `Too ${lastRep.tempo}`,
        at:now, from:now - (lastRep.liftMs ?? 0) - (lastRep.lowerMs ?? 0) - 500 })
    }
  }
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
      const limbs = Object.fromEntries(lanes.map(lane => [`${lane.id}:${lane.current}`, lane.metrics?.[exercise.rep.metric] ?? null]))
      for (const alert of safety.update({ body:bodyFrame(result.landmarks[0], canvas.width, canvas.height), limbs }, now)) showSafety(alert)
      renderMeasurements()
      renderForm()
      renderRepFeedback()
      // Reps since the run was last handed over for saving; saved ones reach the guide from the outbox.
      if (source === 'camera') planGuide.update(lanes.reduce((sum, lane) => sum + lane.assessment.reps - (lane.saved?.reps ?? 0), 0))
      renderCoach()

      const tracked = lanes.filter(lane => lane.measurement)
      for (const lane of tracked) drawPose(lane)
      const recorder = run.recording?.recorder
      if (recorder && source === 'camera') {
        recorder.addFrame(video, canvas, now)
        cutClips(run.recording, run.recording.planner.due(now))
      }
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
    lane.sideChooser.reset()
    lane.smoother.reset()
    lane.pointSmoother.reset()
  }
  setRunning(false)
  planGuide.stop()
  safety?.reset()
  cancelAnimationFrame(animationId)
  finishRun()
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  video.srcObject = null
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  fileInput.disabled = !model
  syncControls()
  clearMeasurements('Form check paused.')
  renderTurn(null)
  status.textContent = 'Stopped. Press Start to go again.'
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
  } else if (!trackerView.hidden) planGuide.load()
})

renderSensor()
loadModel(modelSelect.value)
