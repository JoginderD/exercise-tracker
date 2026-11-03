import test from 'node:test'
import assert from 'node:assert/strict'
import { createVbt, summariseImu } from '../src/vbt.js'

// Deterministic noise, so a failure reproduces.
function noise(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296 - 0.5
  }
}

// Builds a 100 Hz stream of world-frame vertical acceleration for smooth (cosine)
// movements, plus a sensor error: constant bias, slow wander and white noise.
function simulate(moves, { bias = 0.15, wander = 0.1, noiseLevel = 0.3, seed = 1 } = {}) {
  const random = noise(seed)
  const samples = []
  let index = 0
  let moving = false
  const add = (accel, still = false) => {
    const time = index * 10
    const error = bias + wander * Math.sin(time / 7000) + noiseLevel * random()
    samples.push({ index, t:time, q:[1, 0, 0, 0], accel:[0, 0, accel + (still ? 0 : error)], gyro:[still ? 0 : moving ? 20 : 2, 0, 0], still })
    index++
  }
  for (const move of moves) {
    const steps = Math.round(move.ms / 10)
    for (let i = 0; i < steps; i++) {
      moving = !move.rest && !move.hold
      if (move.rest) add(0, true)
      else if (move.hold) add(0)
      else add(move.h * Math.PI ** 2 / (2 * (move.ms / 1000) ** 2) * Math.cos(Math.PI * (i + 0.5) / steps))
    }
  }
  return samples
}

function run(samples, options) {
  const vbt = createVbt(options)
  const events = samples.flatMap(sample => vbt.push(sample))
  return { events:[...events, ...vbt.finish()], vbt }
}

// Curls that slow down: each lift covers 0.4 m, lift time grows from 1.0 s to 1.6 s.
const liftTimes = [1000, 1050, 1100, 1200, 1300, 1400, 1500, 1600]
const curlSet = [
  { rest:true, ms:1000 },
  ...liftTimes.flatMap(ms => [{ h:0.4, ms }, { hold:true, ms:200 }, { h:-0.4, ms:2000 }, { hold:true, ms:300 }]),
  { rest:true, ms:1000 },
]

test('counts curls and measures their concentric velocity despite sensor drift', () => {
  const { events } = run(simulate(curlSet), { massKg:10 })
  assert.equal(events.length, liftTimes.length)
  events.forEach(({ rep }, i) => {
    const truth = 0.4 / (liftTimes[i] / 1000)
    assert.ok(Math.abs(rep.mcv - truth) / truth < 0.1, `rep ${i + 1}: ${rep.mcv} m/s vs ${truth.toFixed(3)}`)
    assert.ok(Math.abs(rep.romCm - 40) < 5, `rep ${i + 1}: ${rep.romCm} cm`)
    assert.ok(Math.abs(rep.concentricMs - liftTimes[i]) < 150, `rep ${i + 1}: lift ${rep.concentricMs} ms`)
    assert.ok(Math.abs(rep.eccentricMs - 2000) < 200, `rep ${i + 1}: lower ${rep.eccentricMs} ms`)
    assert.ok(rep.meanPowerW > 0 && rep.peakPowerW > rep.meanPowerW)
  })
})

test('velocity loss grows as reps slow and flags fatigue past the threshold', () => {
  const { events } = run(simulate(curlSet), { massKg:10, lossThresholdPct:25 })
  const losses = events.map(event => event.rep.velocityLossPct)
  assert.equal(losses[0], 0)
  // The true loss of the last rep is 1 - 1000/1600 = 37.5%.
  assert.ok(Math.abs(losses.at(-1) - 37.5) < 6, `final loss ${losses.at(-1)}%`)
  assert.equal(events[0].fatigued, false)
  assert.equal(events.at(-1).fatigued, true)
  const firstFlag = events.findIndex(event => event.fatigued)
  assert.ok(firstFlag >= 3 && firstFlag <= 5, `first flagged rep ${firstFlag + 1}`)
})

test('squats lower first, then lift', () => {
  const squats = [{ rest:true, ms:1000 }, ...[0, 1, 2].flatMap(() => [{ h:-0.5, ms:1500 }, { hold:true, ms:300 }, { h:0.5, ms:1000 }, { hold:true, ms:500 }]), { rest:true, ms:800 }]
  const { events } = run(simulate(squats, { seed:7 }), { loadStart:'top' })
  assert.equal(events.length, 3)
  for (const { rep } of events) {
    assert.ok(Math.abs(rep.mcv - 0.5) < 0.05, `${rep.mcv}`)
    assert.ok(Math.abs(rep.eccentricMs - 1500) < 200, `${rep.eccentricMs}`)
    assert.equal(rep.meanPowerW, null)
  }
})

test('holding the dumbbell or small wobbles are not reps', () => {
  const fidget = [{ rest:true, ms:500 }, { hold:true, ms:8000 }, { h:0.02, ms:400 }, { h:-0.02, ms:400 }, { hold:true, ms:3000 }, { rest:true, ms:500 }]
  assert.equal(run(simulate(fidget)).events.length, 0)
})

test('a data gap drops the rep in progress and is counted', () => {
  const samples = simulate(curlSet)
  // Lose 0.2 s in the middle of the third lift.
  const start = samples.findIndex(sample => sample.t === 1000 + 3500 * 2 + 1050 + 300)
  const { events, vbt } = run([...samples.slice(0, start), ...samples.slice(start + 20)], { massKg:10 })
  assert.equal(vbt.report().interruptions, 1)
  assert.ok(events.length >= liftTimes.length - 2 && events.length < liftTimes.length, `${events.length} reps`)
})

test('a set stopped mid-lowering still reports its last lift', () => {
  const partial = [{ rest:true, ms:500 }, { h:0.4, ms:1000 }, { hold:true, ms:200 }, { h:-0.4, ms:2000 }, { hold:true, ms:300 }, { h:0.4, ms:1000 }, { hold:true, ms:1500 }]
  const { events } = run(simulate(partial))
  assert.equal(events.length, 2)
  assert.equal(events[1].rep.eccentricMs, null)
})

test('summary matches the reps', () => {
  const { vbt } = run(simulate(curlSet), { massKg:10 })
  const summary = summariseImu(vbt.report())
  assert.equal(summary.reps, liftTimes.length)
  assert.ok(Math.abs(summary.totalWorkJ - 10 * 9.80665 * 0.4 * liftTimes.length) < 25)
  assert.equal(summariseImu({ reps:[] }), null)
})

test('reps without pauses (bouncing at the bottom and top) are still separated', () => {
  const lifts = [900, 1000, 1100, 1250]
  const bounce = [{ rest:true, ms:1000 }, ...lifts.flatMap(ms => [{ h:0.35, ms }, { h:-0.35, ms:1800 }]), { rest:true, ms:1000 }]
  const { events } = run(simulate(bounce, { bias:0.5, seed:3 }))
  assert.equal(events.length, lifts.length)
  events.forEach(({ rep }, i) => {
    const truth = 0.35 / (lifts[i] / 1000)
    assert.ok(Math.abs(rep.mcv - truth) / truth < 0.1, `rep ${i + 1}: ${rep.mcv} vs ${truth.toFixed(3)}`)
  })
})

test('a long rest starts a new set, and velocity loss restarts from its fastest rep', () => {
  const set = [{ h:0.4, ms:1000 }, { hold:true, ms:200 }, { h:-0.4, ms:2000 }, { hold:true, ms:300 }, { h:0.4, ms:1600 }, { hold:true, ms:200 }, { h:-0.4, ms:2000 }]
  const moves = [{ rest:true, ms:500 }, ...set, { rest:true, ms:5000 }, ...set, { rest:true, ms:20000 }, ...set, { rest:true, ms:500 }]
  const { events } = run(simulate(moves))
  assert.deepEqual(events.map(event => event.rep.set), [1, 1, 1, 1, 2, 2])
  // A short pause stays in the set: its fast first rep is compared with the slow rep before it.
  assert.ok(events[2].rep.velocityLossPct < 5)
  assert.equal(events[4].rep.velocityLossPct, 0)
  assert.ok(events[5].fatigued)
})

test('stopping mid-movement keeps finished lifts and drops the fragment', () => {
  const moves = [{ rest:true, ms:500 }, { h:0.4, ms:1000 }, { hold:true, ms:200 }, { h:-0.4, ms:2000 }, { hold:true, ms:300 },
    { h:0.4, ms:1000 }, { hold:true, ms:200 }, { h:-0.4, ms:2000 }, { hold:true, ms:300 }, { h:0.4, ms:600 }]
  const samples = simulate(moves).slice(0, -30)  // cut off 0.3 s before the third lift ends
  const { events } = run(samples)
  assert.equal(events.length, 2)
  for (const { rep } of events) assert.ok(Math.abs(rep.romCm - 40) < 5, `${rep.romCm} cm`)
})
