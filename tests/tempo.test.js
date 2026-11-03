import test from 'node:test'
import assert from 'node:assert/strict'
import { curl } from '../src/exercises.js'
import { createTracker } from '../src/exercise-tracker.js'

// One curl at 30 fps: rest extended, half-cosine lift, optional squeeze, half-cosine lowering, rest.
function curlRep({ lift, lower, squeeze = 0, top = 45, bottom = 165, rest = 500, fps = 30 }) {
  const segments = [
    [rest, () => bottom],
    [lift, f => bottom - (bottom - top) * (1 - Math.cos(Math.PI * f)) / 2],
    [squeeze, () => top],
    [lower, f => top + (bottom - top) * (1 - Math.cos(Math.PI * f)) / 2],
    [rest, () => bottom],
  ]
  const samples = []
  let start = 0
  for (const [duration, angle] of segments) {
    for (let t = 0; t < duration; t += 1000 / fps) samples.push([start + t, angle(t / duration)])
    start += duration
  }
  return samples
}
function play(tracker, samples, offset = 0) {
  let result
  const seen = []
  for (const [t, elbow] of samples) {
    result = tracker.update({ elbow, upperArm: 10 }, offset + t)
    if (result.tempoMessage) seen.push(result.tempoMessage)
  }
  return { ...result, seen }
}

test('controlled curl counts with a good tempo and timings near the real phases', () => {
  const result = play(createTracker(curl), curlRep({ lift: 1000, lower: 2000 }))
  assert.equal(result.reps, 1)
  assert.equal(result.lastRep.tempo, 'good')
  assert.ok(result.lastRep.liftMs > 650 && result.lastRep.liftMs < 1000, `lift ${result.lastRep.liftMs}`)
  assert.ok(result.lastRep.lowerMs > 1300 && result.lastRep.lowerMs < 2000, `lower ${result.lastRep.lowerMs}`)
})

test('a squeeze at the top is not counted as lift or lowering time', () => {
  const plain = play(createTracker(curl), curlRep({ lift: 1000, lower: 2000 })).lastRep
  const squeezed = play(createTracker(curl), curlRep({ lift: 1000, lower: 2000, squeeze: 1500 })).lastRep
  assert.ok(Math.abs(plain.liftMs - squeezed.liftMs) < 70)
  assert.ok(Math.abs(plain.lowerMs - squeezed.lowerMs) < 70)
})

test('swinging the weight up still counts but is flagged too fast', () => {
  const result = play(createTracker(curl), curlRep({ lift: 400, lower: 2000 }))
  assert.equal(result.reps, 1)
  assert.equal(result.fastReps, 1)
  assert.deepEqual(result.lastRep.messages, [curl.tempo.messages.fastLift])
})

test('dropping the weight is flagged too fast on the lowering', () => {
  const result = play(createTracker(curl), curlRep({ lift: 1000, lower: 500 }))
  assert.equal(result.lastRep.tempo, 'fast')
  assert.deepEqual(result.lastRep.messages, [curl.tempo.messages.fastLower])
})

test('very fast reps are all counted, including at 15 fps', () => {
  for (const fps of [30, 15]) {
    const tracker = createTracker(curl)
    let result
    for (let i = 0; i < 5; i++) result = play(tracker, curlRep({ lift: 350, lower: 350, rest: 150, fps }), i * 1000)
    assert.equal(result.reps, 5, `${fps} fps`)
    result = play(tracker, [[0, 165], [150, 165], [300, 165]], 5000)
    assert.equal(result.fastReps, 5, `${fps} fps`)
  }
})

test('very slow reps are flagged too slow and warn while in progress', () => {
  const result = play(createTracker(curl), curlRep({ lift: 9000, lower: 9000 }))
  assert.equal(result.reps, 1)
  assert.equal(result.slowReps, 1)
  assert.equal(result.lastRep.tempo, 'slow')
  assert.ok(result.seen.includes(curl.tempo.messages.stalled))
})

test('a mid-curl stall warns live, a rest at either end does not', () => {
  const tracker = createTracker(curl)
  const rested = play(tracker, curlRep({ lift: 1000, lower: 2000, squeeze: 6000, rest: 6000 }))
  assert.deepEqual(rested.seen, [])
  const stalled = play(tracker, [[0, 165], [200, 165], [300, 110], ...Array.from({ length: 150 }, (_, i) => [333 + i * 33, 110])], 20000)
  assert.equal(stalled.tempoMessage, curl.tempo.messages.stalled)
})

test('a half curl is reported as partial and not counted', () => {
  const result = play(createTracker(curl), curlRep({ lift: 800, lower: 1200, top: 105 }))
  assert.equal(result.reps, 0)
  assert.equal(result.partialReps, 1)
  assert.equal(result.lastRep.missed, 'target')
  assert.ok(Math.abs(result.lastRep.reached - 105) < 1)
})

test('curling again without straightening is partial; the next full extension counts once', () => {
  const tracker = createTracker(curl)
  const samples = [[0, 165], [200, 165], [400, 100], [600, 50], [800, 50], [1000, 110], [1200, 50], [1400, 50], [1600, 110], [1800, 165], [2000, 165]]
  const result = play(tracker, samples.flatMap(([t, a], i) => {
    const [next] = samples[i + 1] ?? [t + 33]
    return Array.from({ length: Math.ceil((next - t) / 33) }, (_, k) => [t + k * 33, a])
  }))
  assert.equal(result.reps, 1)
  assert.equal(result.partialReps, 1)
})

test('tremor near the start does not report partial reps', () => {
  const tracker = createTracker(curl)
  let result
  for (let t = 0; t < 3000; t += 33) result = tracker.update({ elbow: 150 + 15 * Math.sin(t / 100), upperArm: 10 }, t)
  assert.equal(result.partialReps, 0)
  assert.equal(result.reps, 0)
})

test('the last rep keeps its tempo verdict when tracking stops right after it', () => {
  const tracker = createTracker(curl)
  const samples = curlRep({ lift: 1000, lower: 400, rest: 100 })
  play(tracker, samples)
  assert.equal(tracker.update(null, 2700).lastRep, null)
  tracker.resetSequence()
  assert.equal(tracker.update(null, 2800).lastRep.tempo, 'fast')
})

test('the tracker reports waiting until the arm is extended', () => {
  const tracker = createTracker(curl)
  assert.equal(tracker.update({ elbow: 100, upperArm: 10 }, 0).waiting, true)
  tracker.update({ elbow: 160, upperArm: 10 }, 100)
  assert.equal(tracker.update({ elbow: 160, upperArm: 10 }, 200).waiting, false)
})

test('rows and seated leg raises are timed with their own tempo messages', async () => {
  const { row, seatedLegRaise } = await import('../src/exercises.js')
  const rowRep = options => curlRep({ top: 80, bottom: 170, ...options }).map(([t, elbow]) => [t, { elbow, torsoLean: 45 }])
  // Leg raises increase, so mirror the curl shape around the range.
  const legRep = options => curlRep({ top: 90, bottom: 175, ...options }).map(([t, angle]) => [t, { knee: 265 - angle, torsoLean: 5 }])
  for (const [profile, rep] of [[row, rowRep], [seatedLegRaise, legRep]]) {
    const good = createTracker(profile)
    let result
    for (const [t, metrics] of rep({ lift: 1000, lower: 2000, squeeze: 1500 })) result = good.update(metrics, t)
    assert.equal(result.reps, 1, profile.id)
    assert.equal(result.lastRep.tempo, 'good', profile.id)
    const fast = createTracker(profile)
    for (const [t, metrics] of rep({ lift: 300, lower: 2000 })) result = fast.update(metrics, t)
    assert.equal(result.fastReps, 1, profile.id)
    assert.deepEqual(result.lastRep.messages, [profile.tempo.messages.fastLift], profile.id)
  }
})
