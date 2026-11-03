import test from 'node:test'
import assert from 'node:assert/strict'
import { curl } from '../src/exercises.js'
import { createTracker } from '../src/exercise-tracker.js'
import { buildSessionRecord, newRunId } from '../src/session-record.js'
import { validateSession } from '../server/validate.js'

function curlOnce(tracker, start) {
  for (const [offset, elbow] of [[0,160],[160,160],[200,100],[400,60],[560,60],[600,100],[800,160],[960,160],[1300,160]]) {
    tracker.update({ elbow, upperArm:0 }, start + offset)
  }
}
const run = lanes => ({ id:newRunId(), exercise:curl, source:'camera', side:'left', angles:'3d', startedAt:Date.now() - 5000, endedAt:Date.now(), lanes })

test('idle runs produce no record', () => {
  assert.equal(buildSessionRecord(run([{ side:'left', tracker:createTracker(curl) }])), null)
})

test('a run resumed on the same trackers saves only the new reps', () => {
  const lane = { side:'left', tracker:createTracker(curl) }
  curlOnce(lane.tracker, 0)
  lane.tracker.resetSequence()
  const first = buildSessionRecord(run([lane]))
  assert.equal(first.lanes[0].reps, 1)
  assert.equal(buildSessionRecord(run([lane])), null)

  curlOnce(lane.tracker, 5000)
  curlOnce(lane.tracker, 7000)
  lane.tracker.resetSequence()
  const second = buildSessionRecord(run([lane]))
  assert.equal(second.lanes[0].reps, 2)
  assert.deepEqual(second.lanes[0].history.map(rep => rep.number), [2, 3])
})

test('records built by the client pass server validation', () => {
  const lane = { side:'left', tracker:createTracker(curl) }
  curlOnce(lane.tracker, 0)
  lane.tracker.resetSequence()
  const record = JSON.parse(JSON.stringify(buildSessionRecord(run([lane]))))
  const clean = validateSession(record)
  assert.equal(clean.lanes[0].reps, 1)
  assert.equal(clean.lanes[0].history[0].kind, 'full')
})

test('a run with only sensor reps is still saved, and passes validation', () => {
  const lane = { side:'left', tracker:createTracker(curl) }
  const imu = { massKg:null, lossThresholdPct:25, interruptions:0, hand:null, sensor:{ name:'Dumbbell-AB12', firmware:'1.0.0' },
    reps:[{ number:1, mcv:0.5, peakVelocity:0.8, romCm:38, concentricMs:900, eccentricMs:null, meanPowerW:null, peakPowerW:null,
      rotationDeg:100, peakGyroDps:200, velocityLossPct:0 }] }
  assert.equal(buildSessionRecord(run([lane])), null)
  const record = buildSessionRecord({ ...run([lane]), imu })
  assert.equal(record.imu.reps.length, 1)
  assert.equal(validateSession(JSON.parse(JSON.stringify(record))).imu.reps[0].mcv, 0.5)
})

test('a run with only a safety alert is still saved, and passes validation', () => {
  const lane = { side:'left', tracker:createTracker(curl) }
  const safety = [{ kind:'fall', at:Date.now() - 1000 }]
  const record = buildSessionRecord({ ...run([lane]), safety })
  assert.deepEqual(validateSession(JSON.parse(JSON.stringify(record))).safety, safety)
  assert.equal(buildSessionRecord({ ...run([{ side:'left', tracker:createTracker(curl) }]), safety:[] }), null)
})
