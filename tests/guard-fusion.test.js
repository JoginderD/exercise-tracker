import test from 'node:test'
import assert from 'node:assert/strict'
import { createFusion } from '../src/guard-fusion.js'

// Sensor packet whose gyro magnitude is `w` deg/s.
const packet = (w, extra = {}) => ({ ax: 0, ay: 0, az: 1, gx: w, gy: 0, gz: 0, fast: false, ...extra })

// Plays `seconds` of data: the camera at 30 fps, the sensor at 5 Hz (enough for 3-sample averages).
// The camera arm angle swings like a curl (0.5 Hz sine) with a peak speed of `cameraSpeed` deg/s;
// the sensor turns at `sensorW` deg/s. check() runs along the way, as it does on the page.
function play(fusion, from, seconds, { cameraSpeed, sensorW, reps = 0, angleNull = false, noSensor = false }) {
  const amplitude = cameraSpeed / (2 * Math.PI * 0.5)
  let at = from
  for (let i = 0; i < seconds * 30; i++) {
    at = from + i * (1000 / 30)
    const angle = 90 + amplitude * Math.sin(Math.PI * (at / 1000))
    fusion.camera(at, [{ angle: angleNull ? null : angle, reps }])
    if (!noSensor && i % 6 === 0) fusion.imu(packet(sensorW), at)
    if (i % 8 === 0) fusion.check(at)  // the page checks about every 0.25 s; the 3 s hold timer needs this
  }
  return at
}

test('both devices moving: they agree', () => {
  const f = createFusion()
  const end = play(f, 0, 4, { cameraSpeed: 120, sensorW: 120 })
  assert.equal(f.check(end).state, 'agree')
})

test('camera sees movement but the sensor is still for 3 s: sensor-still', () => {
  const f = createFusion()
  const early = play(f, 0, 2, { cameraSpeed: 120, sensorW: 2 })
  assert.notEqual(f.check(early).state, 'sensor-still')  // not long enough yet
  const end = play(f, early + 33, 3, { cameraSpeed: 120, sensorW: 2 })
  assert.equal(f.check(end).state, 'sensor-still')
})

test('sensor moves but the camera sees nothing for 3 s: camera-still', () => {
  const f = createFusion()
  const end = play(f, 0, 6, { cameraSpeed: 0, sensorW: 150 })
  assert.equal(f.check(end).state, 'camera-still')
})

test('sensor moves and no arm is seen at all: camera-still', () => {
  const f = createFusion()
  const end = play(f, 0, 6, { cameraSpeed: 0, sensorW: 150, angleNull: true })
  assert.equal(f.check(end).state, 'camera-still')
})

test('both quiet: idle, no warning', () => {
  const f = createFusion()
  const end = play(f, 0, 5, { cameraSpeed: 0, sensorW: 2 })
  assert.equal(f.check(end).state, 'idle')
})

test('no camera frames lately: camera-off; no sensor data lately: no-sensor', () => {
  const f = createFusion()
  assert.equal(f.check(0).state, 'camera-off')
  const end = play(f, 0, 2, { cameraSpeed: 120, sensorW: 120, noSensor: true })
  assert.equal(f.check(end).state, 'no-sensor')
  assert.equal(f.check(end + 5000).state, 'camera-off')
})

test('a rep counted by the camera gets the sensor peak, peak accel and fast flag of its window', () => {
  const f = createFusion()
  for (let i = 0; i < 100; i++) {
    const at = 1000 + i * 40
    f.imu(packet(i === 50 ? 300 : 100, { ax: 0.5, az: i === 50 ? 2.5 : 1, fast: i === 50 }), at)
  }
  f.camera(5000, [{ angle: 90, reps: 1 }])
  const [rep] = f.reps
  assert.equal(rep.number, 1)
  assert.ok(rep.peakGyro >= 100 && rep.peakGyro <= 300)
  assert.equal(rep.fast, true)
  assert.equal(rep.sensorSeen, true)
  assert.equal(rep.sensorConnected, true)
})

test('a rep with no sensor data says the sensor was not connected', () => {
  const f = createFusion()
  f.camera(5000, [{ angle: 90, reps: 1 }])
  assert.equal(f.reps[0].sensorConnected, false)
  assert.equal(f.reps[0].sensorSeen, false)
})

test('a rep with a still sensor is marked as not seen by the sensor', () => {
  const f = createFusion()
  for (let i = 0; i < 100; i++) f.imu(packet(3), 1000 + i * 40)
  f.camera(5000, [{ angle: 90, reps: 1 }])
  assert.equal(f.reps[0].sensorConnected, true)
  assert.equal(f.reps[0].sensorSeen, false)
})

test('the second rep only looks back to the first one', () => {
  const f = createFusion()
  for (let i = 0; i < 50; i++) f.imu(packet(500), 1000 + i * 40)   // a violent first rep
  f.camera(3000, [{ angle: 90, reps: 1 }])
  for (let i = 0; i < 50; i++) f.imu(packet(60), 3040 + i * 40)    // a gentle second rep
  f.camera(5200, [{ angle: 90, reps: 2 }])
  assert.ok(f.reps[1].peakGyro < 100)
})

test('the camera counter going down (new run) clears the rep list', () => {
  const f = createFusion()
  f.camera(1000, [{ angle: 90, reps: 1 }])
  f.camera(2000, [{ angle: 90, reps: 2 }])
  assert.equal(f.reps.length, 2)
  f.camera(3000, [{ angle: 90, reps: 0 }])
  assert.equal(f.reps.length, 0)
})

test('reps from two limbs are added together', () => {
  const f = createFusion()
  f.camera(1000, [{ angle: 90, reps: 1 }, { angle: 80, reps: 0 }])
  f.camera(2000, [{ angle: 90, reps: 1 }, { angle: 80, reps: 1 }])
  assert.deepEqual(f.reps.map(r => r.number), [1, 2])
})