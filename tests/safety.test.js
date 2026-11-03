import test from 'node:test'
import assert from 'node:assert/strict'
import { curl, row, gobletSquat, deadlift, scaption, squat } from '../src/exercises.js'
import { bodyFrame, createSafetyMonitor, leanLimit } from '../src/safety.js'

// A 1000x1000 image with a 300 px torso: shoulders above hips, leaning `tilt` degrees.
function pose({ hipY = 600, tilt = 0, visibility = 0.9 } = {}) {
  const radians = tilt * Math.PI / 180
  const hipX = 500
  const shoulderX = hipX + Math.sin(radians) * 300
  const shoulderY = hipY - Math.cos(radians) * 300
  const landmarks = []
  for (const index of [11, 12]) landmarks[index] = { x:shoulderX / 1000, y:shoulderY / 1000, visibility }
  for (const index of [23, 24]) landmarks[index] = { x:hipX / 1000, y:hipY / 1000, visibility }
  return landmarks
}
const frame = options => bodyFrame(pose(options), 1000, 1000)
const kinds = alerts => alerts.map(alert => alert.kind)

// Feeds frames every 33 ms from `start`; step(i) returns the frame input. Returns all alerts.
function play(monitor, frames, step, start = 0) {
  const alerts = []
  for (let i = 0; i < frames; i++) alerts.push(...monitor.update(step(i), start + i * 33))
  return alerts
}

test('bodyFrame measures torso size and tilt, and needs a shoulder and a hip', () => {
  const upright = frame()
  assert.equal(Math.round(upright.torso), 300)
  assert.equal(Math.round(upright.tilt), 0)
  assert.equal(Math.round(frame({ tilt:30 }).tilt), 30)
  assert.equal(bodyFrame(pose({ visibility:0.1 }), 1000, 1000), null)
  assert.equal(bodyFrame(undefined, 1000, 1000), null)
})

test('standing still, and a slow controlled squat, raise nothing', () => {
  const monitor = createSafetyMonitor(squat)
  assert.deepEqual(play(monitor, 90, () => ({ body:frame(), limbs:{ left:160 } })), [])
  // Hips down 200 px (0.67 torso) over 1.5 s and back up: about 0.45 torso lengths per second.
  const hipY = i => 600 + 200 * Math.sin(Math.min(i, 90) / 90 * Math.PI)
  assert.deepEqual(play(monitor, 100, i => ({ body:frame({ hipY:hipY(i), tilt:30 }), limbs:{ left:160 - i * 0.6 } }), 3000), [])
})

test('a sudden drop warns, and tipping over straight after is a possible fall', () => {
  const monitor = createSafetyMonitor(curl)
  play(monitor, 10, () => ({ body:frame() }))
  // Hips fall 300 px (one torso) in 200 ms: 5 torso lengths per second.
  const drop = play(monitor, 7, i => ({ body:frame({ hipY:600 + i * 50 }) }), 330)
  assert.deepEqual(kinds(drop), ['drop'])
  assert.equal(drop[0].severity, 'caution')
  const after = play(monitor, 10, () => ({ body:frame({ hipY:900, tilt:80 }) }), 560)
  assert.ok(kinds(after).includes('fall'))
  assert.equal(after.find(alert => alert.kind === 'fall').severity, 'danger')
})

test('vanishing after a drop is a possible fall, but one missed frame is not', () => {
  const monitor = createSafetyMonitor(curl)
  play(monitor, 10, () => ({ body:frame() }))
  play(monitor, 7, i => ({ body:frame({ hipY:600 + i * 50 }) }), 330)
  // One missing frame, then the person is back in view: no fall.
  assert.deepEqual(monitor.update({ body:null }, 560), [])
  assert.deepEqual(play(monitor, 3, () => ({ body:frame({ hipY:900 }) }), 593), [])
  // Gone for over 300 ms: possible fall.
  assert.deepEqual(kinds(play(monitor, 12, () => ({ body:null }), 700)), ['fall'])
})

test('losing the person without a drop (walking away) is not a fall', () => {
  const monitor = createSafetyMonitor(curl)
  play(monitor, 10, () => ({ body:frame() }))
  assert.deepEqual(play(monitor, 60, () => ({ body:null }), 330), [])
})

test('leaning off balance warns once held, using each exercise\'s limit', () => {
  assert.equal(leanLimit(curl), 20)
  assert.equal(leanLimit(squat), 70)
  assert.equal(leanLimit(row), null)
  assert.equal(leanLimit(gobletSquat), 60)
  assert.equal(leanLimit(deadlift), null)
  assert.equal(leanLimit(scaption), 20)

  const monitor = createSafetyMonitor(curl)
  // A brief lean is ignored.
  assert.deepEqual(play(monitor, 10, () => ({ body:frame({ tilt:30 }) })), [])
  play(monitor, 5, () => ({ body:frame() }), 330)
  assert.deepEqual(kinds(play(monitor, 30, () => ({ body:frame({ tilt:30 }) }), 500)), ['balance'])
  // A hinged row leans on purpose and is never warned.
  assert.deepEqual(play(createSafetyMonitor(row), 60, () => ({ body:frame({ tilt:80 }) })), [])
})

test('a limb whipping through the movement warns; one glitched frame does not', () => {
  const monitor = createSafetyMonitor(curl)
  // 60° in 100 ms is 600 °/s.
  const elbow = i => i < 10 ? 160 : Math.max(100, 160 - (i - 10) * 20)
  assert.deepEqual(kinds(play(monitor, 20, i => ({ body:frame(), limbs:{ 'left:left':elbow(i) } }))), ['jerk'])

  const glitch = createSafetyMonitor(curl)
  assert.deepEqual(play(glitch, 20, i => ({ body:frame(), limbs:{ 'left:left':i === 10 ? 100 : 160 } })), [])
})

test('the same alert is not repeated within the cooldown', () => {
  const monitor = createSafetyMonitor(curl, { cooldownMs:6000 })
  const alerts = play(monitor, 120, () => ({ body:frame({ tilt:30 }) }))
  assert.deepEqual(kinds(alerts), ['balance'])
  assert.deepEqual(kinds(play(monitor, 30, () => ({ body:frame({ tilt:30 }) }), 7000)), ['balance'])
})

test('a dumbbell in free fall for 100 ms is flagged; lowering it is not', () => {
  const monitor = createSafetyMonitor(curl)
  const sample = (t, az, still = false) => ({ t, accel:[0, 0, az], still })
  for (let t = 0; t < 1000; t += 10) assert.deepEqual(monitor.imu(sample(t, -3), t), [])
  const alerts = []
  for (let t = 1000; t < 1200; t += 10) alerts.push(...monitor.imu(sample(t, -9.6), t))
  assert.deepEqual(kinds(alerts), ['dropped-weight'])
})
