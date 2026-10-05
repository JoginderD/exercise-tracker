import test from 'node:test'
import assert from 'node:assert/strict'
import { curl } from '../src/exercises.js'
import { measurePose, createTracker } from '../src/exercise-tracker.js'

function sample(tracker, elbow, upper, time) {
  return tracker.update({ elbow, upperArm: upper }, time)
}
function cycle(tracker, upper = 0, start = 0) {
  let result
  for (const [offset, angle] of [[0,160],[160,160],[200,100],[400,60],[560,60],[600,100],[800,160],[960,160]]) {
    result = sample(tracker, angle, upper, start + offset)
  }
  return result
}

test('complete curl counts once and holding still does not repeat', () => {
  const tracker = createTracker(curl)
  assert.equal(cycle(tracker).reps, 1)
  assert.equal(sample(tracker, 160, 0, 1100).reps, 1)
})
test('sustained raised arm flags the completed rep without deleting it', () => {
  const result = cycle(createTracker(curl), 90)
  assert.equal(result.reps, 1)
  assert.equal(result.flaggedReps, 1)
  assert.equal(result.form, 'warning')
})
test('short angle spikes do not trigger a warning', () => {
  const tracker = createTracker(curl)
  sample(tracker,160,0,0)
  assert.equal(sample(tracker,160,90,100).form, 'pending')
  assert.equal(sample(tracker,160,0,200).form, 'within')
})
test('warning clears only below the recovery threshold', () => {
  const tracker = createTracker(curl)
  sample(tracker,160,40,0)
  assert.equal(sample(tracker,160,40,300).form,'warning')
  assert.equal(sample(tracker,160,28,400).form,'warning')
  assert.equal(sample(tracker,160,20,500).form,'within')
})
test('partial curls and brief threshold crossings do not count', () => {
  const tracker = createTracker(curl)
  for (const [t,a] of [[0,160],[160,160],[200,60],[250,100],[400,160],[560,160]]) sample(tracker,a,0,t)
  assert.equal(sample(tracker,160,0,700).reps,0)
})
test('missing measurements discard unfinished repetitions', () => {
  const tracker = createTracker(curl)
  sample(tracker,160,0,0); sample(tracker,160,0,160)
  sample(tracker,60,0,200); sample(tracker,60,0,360)
  assert.equal(tracker.update(null,400).form,'unassessable')
  sample(tracker,160,0,500)
  assert.equal(sample(tracker,160,0,660).reps,0)
})
test('long frame gaps cannot bridge an unfinished rep', () => {
  const tracker = createTracker(curl)
  sample(tracker,160,0,0); sample(tracker,160,0,160)
  sample(tracker,60,0,200); sample(tracker,60,0,360)
  sample(tracker,160,0,2000)
  assert.equal(sample(tracker,160,0,2160).reps,0)
})
test('other profiles can count increasing angles without the curl form rule', () => {
  const tracker = createTracker({ ...curl, rep: {metric:'elbow',start:30,target:120,direction:'increasing',holdMs:150}, formRules:[] })
  for (const [t,a] of [[0,20],[160,20],[200,130],[360,130],[400,20]]) sample(tracker,a,90,t)
  assert.equal(sample(tracker,20,90,560).reps,1)
  assert.equal(sample(tracker,20,90,600).flaggedReps,0)
})
test('resetting a sequence preserves completed counts; new tracker resets counts', () => {
  const tracker = createTracker(curl)
  cycle(tracker)
  tracker.resetSequence()
  assert.equal(sample(tracker,160,0,1200).reps,1)
  assert.equal(sample(createTracker(curl),160,0,0).reps,0)
})
function pose(side, raised) {
  const points = Array.from({length:33},()=>({x:0,y:0,visibility:0}))
  const ids = side === 'left' ? [11,13,15,23] : [12,14,16,24]
  const coords = raised ? [[.5,.2],[.7,.2],[.7,.4],[.5,.8]] : [[.5,.2],[.5,.5],[.7,.5],[.5,.8]]
  ids.forEach((id,i)=>points[id]={x:coords[i][0],y:coords[i][1],visibility:1})
  return points
}
for (const side of ['left','right']) test(`${side} arm measures torso-relative angle using pixel coordinates`, () => {
  const down = measurePose(pose(side,false),side,1280,720,curl)
  const raised = measurePose(pose(side,true),side,1280,720,curl)
  assert.equal(down.metrics.upperArm,0)
  assert.equal(raised.metrics.upperArm,90)
  assert.equal(down.metrics.elbow,90)
})
test('hidden hip and nonfinite points are unassessable', () => {
  const points = pose('left',false)
  points[23].visibility=.1
  assert.equal(measurePose(points,'left',1280,720,curl),null)
  points[23].visibility=1; points[13].x=NaN
  assert.equal(measurePose(points,'left',1280,720,curl),null)
})
