// Compares what the camera sees with what the Curl Guard sensor feels. Pure logic with no
// page code, so it is easy to test. guard-panel.js feeds it and shows the result.
//
// Two jobs:
//   1. Cross-check: the arm is moving according to the camera, so the sensor on the dumbbell
//      should be moving too, and the other way round. A long disagreement points to a
//      detached or dead sensor, or to a camera that cannot see the person.
//   2. Per-rep sensor data: each time the camera counts a rep, record how hard the sensor
//      was moving during that rep.
//
// The two devices use different coordinate systems and Bluetooth adds some delay, so only
// "is it moving, and how fast" over a window of about 2 seconds is compared, never values.

const IMU_KEEP_MS = 12000   // how long sensor samples are remembered
const CAMERA_KEEP_MS = 4000 // how long camera frames are remembered
const WINDOW_MS = 2000      // peaks are taken over this much recent time
const HOLD_MS = 3000        // a disagreement must last this long before it is reported
const LIVE_MS = 1000        // data older than this means that device is not running
const MAX_REP_MS = 5000     // a rep window never reaches back further than this
const KEEP_REPS = 20        // how many rep records are remembered

const CAMERA_MOVING = 40    // deg/s of arm angle that counts as "the camera sees movement"
const CAMERA_STILL = 10     // below this the camera sees no movement
const SENSOR_MOVING = 80    // deg/s of sensor rotation that counts as "the sensor is moving"
const SENSOR_STILL = 15     // below this the sensor feels no movement
const REP_SEEN = 40         // a counted rep with a sensor peak below this is suspicious
const SPEED_SPAN_MS = 150   // camera speed is measured over at least this much time

export const CHECK_MESSAGES = {
  'camera-off': 'Camera is off, so the cross-check is paused.',
  'no-sensor': 'Guard is not sending data, so the cross-check is paused.',
  idle: 'Waiting for movement.',
  agree: 'Camera and sensor agree.',
  'sensor-still': 'The camera sees the arm moving, but the sensor is not. Is it attached to the dumbbell and switched on?',
  'camera-still': 'The sensor is moving, but the camera does not see the arm moving. Step into view or check the camera angle.',
}

// Largest 3-sample average of the values in [from, to]. Averaging three samples
// (about 0.1 s) stops one noisy sample from counting as a peak.
function peak(samples, key, from, to) {
  const inside = samples.filter(sample => sample.at >= from && sample.at <= to)
  let best = 0
  for (let i = 2; i < inside.length; i++) {
    best = Math.max(best, (inside[i][key] + inside[i - 1][key] + inside[i - 2][key]) / 3)
  }
  return best
}

export function createFusion() {
  let imu = []            // { at, w (deg/s), a (g), fast }
  let frames = []         // { at, speed (deg/s) or null when no arm was seen }
  let angles = []         // one list of { at, angle } per camera lane
  let lastFrameAt = null
  let totalReps = 0
  let lastRepAt = null
  let reps = []
  let sensorStillSince = null
  let cameraStillSince = null

  return {
    // A sensor packet (as decoded by parsePacket) that arrived at time `at` (ms).
    imu(packet, at) {
      imu.push({
        at,
        w: Math.hypot(packet.gx, packet.gy, packet.gz),
        a: Math.hypot(packet.ax, packet.ay, packet.az),
        fast: Boolean(packet.fast),
      })
      imu = imu.filter(sample => sample.at >= at - IMU_KEEP_MS)
    },

    // One camera frame at time `at` (ms). lanes: [{ angle, reps }] per tracked limb, where
    // angle is the rep angle in degrees (or null when the arm is not seen).
    camera(at, lanes) {
      let speed = null
      lanes.forEach((lane, index) => {
        const list = angles[index] ??= []
        if (Number.isFinite(lane.angle)) {
          list.push({ at, angle: lane.angle })
          const older = [...list].reverse().find(sample => at - sample.at >= SPEED_SPAN_MS)
          if (older) {
            const laneSpeed = Math.abs(lane.angle - older.angle) / ((at - older.at) / 1000)
            speed = Math.max(speed ?? 0, laneSpeed)
          }
        }
        while (list.length && list[0].at < at - CAMERA_KEEP_MS) list.shift()
      })
      frames.push({ at, speed })
      frames = frames.filter(frame => frame.at >= at - CAMERA_KEEP_MS)
      lastFrameAt = at

      const total = lanes.reduce((sum, lane) => sum + (Number.isFinite(lane.reps) ? lane.reps : 0), 0)
      if (total < totalReps) {  // a new run started: the camera counter went back down
        reps = []
        lastRepAt = null
      } else if (total > totalReps) {
        // The rep ended just now. Look back to the previous rep, but not further than MAX_REP_MS.
        const from = Math.max(lastRepAt ?? -Infinity, at - MAX_REP_MS)
        const window = imu.filter(sample => sample.at >= from && sample.at <= at)
        const peakGyro = peak(imu, 'w', from, at)
        reps.push({
          number: total,
          at,
          peakGyro: Math.round(peakGyro),
          peakAccel: Number(peak(imu, 'a', from, at).toFixed(2)),
          fast: window.some(sample => sample.fast),
          samples: window.length,
          // No data at all means the guard was not connected for this rep.
          sensorSeen: window.length > 0 && peakGyro >= REP_SEEN,
          sensorConnected: window.length > 0,
        })
        reps = reps.slice(-KEEP_REPS)
        lastRepAt = at
      }
      totalReps = total
    },

    // The cross-check verdict at time `at`: { state, message }.
    check(at) {
      const result = state => ({ state, message: CHECK_MESSAGES[state] })
      const cameraLive = lastFrameAt !== null && at - lastFrameAt <= LIVE_MS
      const sensorLive = imu.length > 0 && at - imu[imu.length - 1].at <= LIVE_MS
      if (!cameraLive) { sensorStillSince = cameraStillSince = null; return result('camera-off') }
      if (!sensorLive) { sensorStillSince = cameraStillSince = null; return result('no-sensor') }

      const from = at - WINDOW_MS
      const speeds = frames.filter(frame => frame.at >= from && frame.speed !== null).map(frame => frame.speed)
      const cameraPeak = speeds.length ? Math.max(...speeds) : null  // null: no arm seen at all
      const sensorPeak = peak(imu, 'w', from, at)

      const sensorStill = cameraPeak !== null && cameraPeak >= CAMERA_MOVING && sensorPeak < SENSOR_STILL
      const cameraStill = sensorPeak >= SENSOR_MOVING && (cameraPeak === null || cameraPeak < CAMERA_STILL)
      sensorStillSince = sensorStill ? sensorStillSince ?? at : null
      cameraStillSince = cameraStill ? cameraStillSince ?? at : null

      if (sensorStillSince !== null && at - sensorStillSince >= HOLD_MS) return result('sensor-still')
      if (cameraStillSince !== null && at - cameraStillSince >= HOLD_MS) return result('camera-still')
      if (cameraPeak !== null && cameraPeak >= CAMERA_MOVING && sensorPeak >= SENSOR_STILL) return result('agree')
      return result('idle')
    },

    // The most recent rep records, oldest first.
    get reps() { return reps.slice() },
    // Forget everything, for example when the user starts a new session.
    reset() {
      imu = []; frames = []; angles = []; lastFrameAt = null
      totalReps = 0; lastRepAt = null; reps = []
      sensorStillSince = cameraStillSince = null
    },
  }
}