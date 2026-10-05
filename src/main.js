import './style.css'
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

  <div class="camera-container">
    <video id="webcam" autoplay playsinline muted></video>
    <canvas id="overlay"></canvas>
  </div>

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

let model
let stream
let running = false
let animationId
let lastVideoTime = -1

const repsLabel = document.querySelector('#reps')

function clearMeasurements(message) {
  angleLabel.textContent = 'Elbow angle: —'
  upperArmLabel.textContent = 'Upper arm / torso: —'
  formLabel.dataset.state = 'unassessable'
  formLabel.textContent = message
}

armSelect.addEventListener('change', () => {
  tracker = createTracker(exercise)
  repsLabel.textContent = 'Reps: 0'
  flaggedLabel.textContent = 'Reps with upper-arm flag: 0'
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  clearMeasurements('Arm changed. Begin with your arm extended.')
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

    status.textContent = 'Model ready. Start your camera.'
    startButton.disabled = false
  } catch (error) {
    status.textContent = `Model failed to load: ${error.message}`
  }
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true
  status.textContent = 'Starting camera…'

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    })

    video.srcObject = stream
    await video.play()

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

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
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime
      const result = model.detectForVideo(video, performance.now())

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const now = performance.now()
      const measurement = measurePose(
        result.landmarks[0], armSelect.value, canvas.width, canvas.height, exercise,
      )
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
        status.textContent = 'Tracking — keep your selected side facing the camera.'
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
  tracker.resetSequence()
  running = false
  cancelAnimationFrame(animationId)
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  video.srcObject = null
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  startButton.disabled = !model
  stopButton.disabled = true
  clearMeasurements('Form check paused.')
  status.textContent = 'Camera stopped.'
}

stopButton.addEventListener('click', stopCamera)
window.addEventListener('pagehide', stopCamera)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) stopCamera()
})

loadModel()
