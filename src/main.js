import './style.css'
import { createAngleGraph } from './angle-graph.js'
import { curl } from './exercises.js'
import { createTracker, measurePose } from './exercise-tracker.js'

const exercise = curl
let tracker = createTracker(exercise)
import {
  PoseLandmarker,
  FilesetResolver,
} from '@mediapipe/tasks-vision'

document.querySelector('#app').innerHTML = `
  <h1>Exercise Tracker · ${exercise.name}</h1>
  <p>${exercise.instructions}</p>
  <p id="status">Loading pose model…</p>

  <div class="video-input">
    <label>Open local test video: <input id="video-file" type="file" accept="video/*" disabled></label>
    <p id="video-name" class="hint">No video selected. Files are processed locally, never uploaded.</p>
    <button id="replay" disabled>Replay from start</button>
  </div>

  <div class="camera-container">
    <video id="webcam" playsinline muted></video>
    <canvas id="overlay"></canvas>
  </div>

  <section class="angle-chart" aria-labelledby="graph-title">
    <h2 id="graph-title">Elbow angle · last 10 seconds</h2>
    <canvas id="angle-graph" role="img" aria-label="Live elbow angle over the last ten seconds, from 0 to 180 degrees. Missing tracking leaves gaps."></canvas>
    <p class="hint">Cyan: measured angle · Dashed: curl thresholds (${exercise.rep.target}° / ${exercise.rep.start}°).<br>
    Gaps mean tracking is unavailable. The graph pauses when playback or the camera stops.</p>
  </section>

  <h2 id="angle">Elbow angle: —</h2>
  <h2 id="upper-arm">Upper arm / torso: —</h2>
  <p id="form" data-state="unassessable" role="status">Form check waiting for camera.</p>
  <h2 id="reps">Reps: 0</h2>
  <p id="flagged">Reps with upper-arm flag: 0</p>
  <p class="hint">Prototype curl check: upper arm over 30° for 0.3 seconds triggers feedback.
  This checks one visible movement feature, not overall exercise safety.</p>

  <label>
    Arm to track:
    <select id="arm">
      <option value="left">Left</option>
      <option value="right">Right</option>
    </select>
  </label>

  <div>
    <button id="start" disabled>Start Camera</button>
    <button id="stop" disabled>Stop Camera</button>
  </div>
`

const angleGraph = createAngleGraph(document.querySelector('#angle-graph'), [exercise.rep.target, exercise.rep.start])
const video = document.querySelector('#webcam')
const canvas = document.querySelector('#overlay')
const ctx = canvas.getContext('2d')
const status = document.querySelector('#status')
const angleLabel = document.querySelector('#angle')
const upperArmLabel = document.querySelector('#upper-arm')
const formLabel = document.querySelector('#form')
const flaggedLabel = document.querySelector('#flagged')
const armSelect = document.querySelector('#arm')
const startButton = document.querySelector('#start')
const stopButton = document.querySelector('#stop')
const fileInput = document.querySelector('#video-file')
const videoName = document.querySelector('#video-name')
const replayButton = document.querySelector('#replay')

let model
let stream
let running = false
let animationId
let lastVideoTime = -1
let source = 'camera'
let fileUrl
let cameraRequest = 0

const repsLabel = document.querySelector('#reps')

function clearMeasurements(message) {
  angleLabel.textContent = 'Elbow angle: —'
  upperArmLabel.textContent = 'Upper arm / torso: —'
  formLabel.dataset.state = 'unassessable'
  formLabel.textContent = message
}

function resetRun() {
  tracker = createTracker(exercise)
  angleGraph.clear()
  repsLabel.textContent = 'Reps: 0'
  flaggedLabel.textContent = 'Reps with upper-arm flag: 0'
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  lastVideoTime = -1
  clearMeasurements('Begin with your arm extended.')
}
armSelect.addEventListener('change', resetRun)

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
  resetRun()
  videoName.textContent = file.name
  fileUrl = URL.createObjectURL(file)
  video.src = fileUrl
  video.load()
  status.textContent = 'Loading local video…'
  fileInput.value = ''
})

video.addEventListener('loadedmetadata', () => {
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  if (source === 'file') {
    replayButton.disabled = false
    status.textContent = 'Video ready. Press Play to analyse it.'
  }
})
video.addEventListener('play', () => {
  if (source !== 'file' || !model) return
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
  if (source === 'file') status.textContent = 'Video finished. Replay to start a new run.'
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

async function loadModel() {
  try {
    const vision = await FilesetResolver.forVisionTasks('/wasm')

    model = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
    })

    status.textContent = 'Model ready. Start your camera or open a local video.'
    fileInput.disabled = false
    startButton.disabled = false
  } catch (error) {
    status.textContent = `Model failed to load: ${error.message}`
  }
}

startButton.addEventListener('click', async () => {
  stopCamera()
  releaseFile()
  source = 'camera'
  video.controls = false
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
    fileInput.disabled = false

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

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

function drawPose(points, warning) {
  ctx.lineWidth = 5
  for (const [from, to] of exercise.connections) {
    ctx.strokeStyle = to === 'hip' ? '#94a3b8' : warning ? '#fb923c' : '#22d3ee'
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

function trackPose() {
  if (!running) return

  try {
    if (!video.seeking && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime
      const result = model.detectForVideo(video, performance.now())

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      // Exercise timing follows the clip, independent of playback speed or pauses.
      const now = source === 'file' ? video.currentTime * 1000 : performance.now()
      const measurement = measurePose(
        result.landmarks[0], armSelect.value, canvas.width, canvas.height, exercise,
      )
      angleGraph.add(now, measurement?.metrics.elbow)
      const assessment = tracker.update(measurement?.metrics, now)
      repsLabel.textContent = `Reps: ${assessment.reps}`
      flaggedLabel.textContent = `Reps with upper-arm flag: ${assessment.flaggedReps}`

      if (measurement) {
        angleLabel.textContent = `Elbow angle: ${measurement.metrics.elbow.toFixed(0)}°`
        upperArmLabel.textContent = `Upper arm / torso: ${measurement.metrics.upperArm.toFixed(0)}°`
        formLabel.dataset.state = assessment.form
        formLabel.textContent = assessment.form === 'warning'
          ? assessment.messages.join(' ')
          : assessment.form === 'pending'
            ? 'Checking upper-arm position…'
            : 'Upper-arm position within the configured limit.'
        drawPose(measurement.points, assessment.form === 'warning')
        status.textContent = source === 'file' ? 'Analysing local video…' : 'Tracking — keep your selected side facing the camera.'
      } else {
        clearMeasurements('Cannot assess — keep shoulder, elbow, wrist and hip visible.')
        status.textContent = 'Reposition so your selected arm and hip are visible.'
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
  tracker.resetSequence()
  running = false
  cancelAnimationFrame(animationId)
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  video.srcObject = null
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  fileInput.disabled = !model
  startButton.disabled = !model
  stopButton.disabled = true
  clearMeasurements('Form check paused.')
  status.textContent = 'Camera stopped.'
}

stopButton.addEventListener('click', stopCamera)
window.addEventListener('pagehide', () => { stopCamera(); releaseFile() })
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (source === 'file') video.pause()
    else stopCamera()
  }
})

loadModel()
