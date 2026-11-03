import test from 'node:test'
import assert from 'node:assert/strict'
import { curl, exercises, lateralRaise, shoulderPress, squat } from '../src/exercises.js'
import { chooseSide, createTracker, measurePose } from '../src/exercise-tracker.js'
import { createMetricSmoother, createOneEuroFilter } from '../src/smoothing.js'

function body(joints, visibility = 1) {
  const points = Array.from({length:33},()=>({x:.5,y:.5,visibility:0}))
  for (const [index,[x,y,z=0]] of Object.entries(joints)) points[index] = {x,y,z,visibility}
  return points
}

test('every profile is complete and its metrics and connections use tracked joints', () => {
  assert.equal(new Set(exercises.map(profile => profile.id)).size, exercises.length)
  for (const profile of exercises) {
    const joints = Object.keys(profile.landmarks.left)
    assert.deepEqual(Object.keys(profile.landmarks.right), joints, profile.id)
    for (const definition of Object.values(profile.metrics)) {
      for (const joint of Array.isArray(definition) ? definition : definition.segment) assert.ok(joints.includes(joint), `${profile.id}: ${joint}`)
    }
    for (const [from,to] of profile.connections) assert.ok(joints.includes(from) && joints.includes(to), profile.id)
    for (const name of Object.keys(profile.metrics)) assert.ok(profile.labels[name], `${profile.id}: label ${name}`)
    assert.ok(profile.metrics[profile.rep.metric], profile.id)
    for (const rule of profile.formRules) assert.ok(profile.metrics[rule.metric] && (rule.max !== undefined ? rule.clearBelow < rule.max : rule.clearAbove > rule.min), profile.id)
    assert.ok(['left','right','auto','each'].includes(profile.defaultSide), profile.id)
    assert.ok(profile.startCue, profile.id)
    assert.ok(['camera','side'].includes(profile.facing), profile.id)
  }
})

test('3D world landmarks recover an elbow angle that is foreshortened in the image', () => {
  // Forearm points at the camera: it looks straight in the image but is bent 90° in space.
  const image = body({11:[.5,.2],13:[.5,.5],15:[.5,.55],23:[.5,.8]})
  const world = body({11:[0,-.5,0],13:[0,-.2,0],15:[0,-.2,-.3],23:[0,0,0]})
  const flat = measurePose(image,'left',1280,720,curl)
  const spatial = measurePose(image,'left',1280,720,curl,world)
  assert.equal(flat.space,'2d')
  assert.equal(Math.round(flat.metrics.elbow),180)
  assert.equal(spatial.space,'3d')
  assert.equal(Math.round(spatial.metrics.elbow),90)
  assert.deepEqual(spatial.points, flat.points)
})

test('missing world coordinates fall back to image angles instead of failing', () => {
  const image = body({11:[.5,.2],13:[.5,.5],15:[.7,.5],23:[.5,.8]})
  const world = body({11:[0,-.5,0],13:[NaN,-.2,0],15:[0,-.2,-.3],23:[0,0,0]})
  const result = measurePose(image,'left',1280,720,curl,world)
  assert.equal(result.space,'2d')
  assert.equal(result.metrics.elbow,90)
})

test('squat measures knee bend and torso lean from vertical', () => {
  const standing = body({12:[.5,.2],24:[.5,.5],26:[.5,.7],28:[.5,.9]})
  const deep = body({12:[.3,.3],24:[.3,.6],26:[.5,.6],28:[.5,.9]})
  const leaning = body({12:[.2,.38],24:[.5,.6],26:[.6,.6],28:[.6,.9]})
  assert.deepEqual(measurePose(standing,'right',1000,1000,squat).metrics,{knee:180,torsoLean:0})
  assert.equal(measurePose(deep,'right',1000,1000,squat).metrics.knee,90)
  assert.ok(Math.abs(measurePose(leaning,'right',1000,1000,squat).metrics.torsoLean - 53.7) < 0.1)
})

test('arm elevation counts lateral raises and flags raises above shoulder height', () => {
  const tracker = createTracker(lateralRaise)
  let result
  for (const [t,raise] of [[0,10],[160,10],[200,90],[360,90],[400,120],[700,120],[720,10],[900,10]]) {
    result = tracker.update({armRaise:raise,elbow:170},t)
  }
  assert.equal(result.reps,1)
  assert.equal(result.flaggedReps,1)
})

test('shoulder press counts a press and ignores a curl-height movement', () => {
  const tracker = createTracker(shoulderPress)
  for (const [t,raise] of [[0,85],[160,85],[200,165],[360,165],[400,85],[560,85]]) tracker.update({armRaise:raise,elbow:120},t)
  assert.equal(tracker.update({armRaise:85,elbow:120},600).reps,1)
  for (const [t,raise] of [[700,20],[900,40],[1100,20],[1300,20]]) tracker.update({armRaise:raise,elbow:40},t)
  assert.equal(tracker.update({armRaise:20,elbow:170},1400).reps,1)
})

test('auto side keeps the current side until the other is clearly more visible', () => {
  const both = (left,right) => {
    const points = body({11:[.4,.2],13:[.4,.5],15:[.4,.6],23:[.4,.8],12:[.6,.2],14:[.6,.5],16:[.6,.6],24:[.6,.8]})
    for (const i of [11,13,15,23]) points[i].visibility = left
    for (const i of [12,14,16,24]) points[i].visibility = right
    return points
  }
  assert.equal(chooseSide(both(.8,.9),curl,null),'right')
  assert.equal(chooseSide(both(.85,.9),curl,'left'),'left')
  assert.equal(chooseSide(both(.75,.95),curl,'left'),'right')
  assert.equal(chooseSide(both(.4,.6),curl,'left'),'right')
  const offFrame = both(.99,.8); offFrame[15].x = 1.2
  assert.equal(chooseSide(offFrame,curl,'left'),'right')
  assert.equal(chooseSide(undefined,curl,'left'),'left')
})

test('smoothing removes still-position jitter but follows real movement', () => {
  const filter = createOneEuroFilter()
  const still = []
  for (let i = 0; i < 90; i++) still.push(filter.filter(150 + (i % 2 ? 6 : -6), i * 33))
  const settled = still.slice(30)
  assert.ok(Math.max(...settled) - Math.min(...settled) < 3)
  let value
  for (let i = 90; i < 120; i++) value = filter.filter(60, i * 33)
  assert.ok(Math.abs(value - 60) < 1)
})

test('smoothed noisy curls at 30 fps still count every rep', () => {
  const tracker = createTracker(curl)
  const smoother = createMetricSmoother(curl.maxGapMs)
  let seed = 7
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - .5) * 16
  let result
  for (let t = 0; t <= 12500; t += 33) {
    // 1.5 s reps between 165° and 45° with ±8° jitter.
    const elbow = 105 + 60 * Math.cos(2 * Math.PI * t / 1500) + noise()
    result = tracker.update(smoother.smooth({elbow,upperArm:10+noise()/4},t),t)
  }
  assert.equal(result.reps,8)
})

test('smoother passes missing metrics through and times each metric gap separately', () => {
  const smoother = createMetricSmoother(500)
  smoother.smooth({elbow:160,upperArm:10},0)
  assert.deepEqual(smoother.smooth({elbow:160,upperArm:null},33),{elbow:160,upperArm:null})
  for (let t = 66; t <= 1000; t += 33) smoother.smooth({elbow:160,upperArm:null},t)
  assert.equal(smoother.smooth({elbow:160,upperArm:40},1033).upperArm,40)
})

test('hiddenJoints names exactly the joints that are missing', async () => {
  const { hiddenJoints } = await import('../src/exercise-tracker.js')
  const points = body({11:[.5,.2],13:[.5,.5],15:[.7,.5],23:[.5,.8]})
  points[15].visibility = .2
  points[23].x = 1.3
  assert.deepEqual(hiddenJoints(points,'left',curl),['wrist','hip'])
  assert.deepEqual(hiddenJoints(undefined,'left',curl),['shoulder','elbow','wrist','hip'])
})

test('smoother restarts after a tracking gap', () => {
  const smoother = createMetricSmoother(500)
  smoother.smooth({elbow:160},0)
  assert.equal(smoother.smooth({elbow:60},1000).elbow,60)
  assert.equal(smoother.smooth(null,1033),null)
})

test('body turn is ~0° facing the camera and ~90° side-on, naming the far side', async () => {
  const { bodyTurn } = await import('../src/exercise-tracker.js')
  const torso = (shoulderDz, hipDz) => {
    const points = body({})
    points[11] = {x:-.18,y:-.5,z:-shoulderDz/2}; points[12] = {x:.18,y:-.5,z:shoulderDz/2}
    points[23] = {x:-.1,y:0,z:-hipDz/2}; points[24] = {x:.1,y:0,z:hipDz/2}
    return points
  }
  assert.ok(bodyTurn(torso(0,0)).yaw < 1)
  const turned = bodyTurn(torso(.36,.2))
  assert.ok(Math.abs(turned.yaw - 45) < 1)
  assert.equal(turned.far,'right')
  const side = bodyTurn(torso(-.36,-.2).map((p,i) => [11,12,23,24].includes(i) ? {...p,x:p.x/20} : p))
  assert.ok(side.yaw > 85)
  assert.equal(side.far,'left')
  assert.equal(bodyTurn(undefined),null)
})

function feed(guide, yaw, far, from, to) {
  let result
  for (let t = from; t <= to; t += 33) result = guide.update({yaw,far}, t)
  return result
}

test('turn guide warns after a sustained turn and says which way to face the camera', async () => {
  const { createTurnGuide } = await import('../src/exercise-tracker.js')
  const guide = createTurnGuide('camera')
  assert.equal(feed(guide, 5, 'right', 0, 1000).active, false)
  // Right shoulder further away = turned to the right, so turn left to face the camera.
  const turned = feed(guide, 40, 'right', 1033, 4000)
  assert.equal(turned.active, true)
  assert.equal(turned.turn, 'left')
  assert.ok(Math.abs(turned.deviation - 40) < 2)
  assert.equal(feed(guide, 40, 'left', 4033, 4100).turn, 'right')
})

test('turn guide ignores brief noisy turns and clears only once back near straight', async () => {
  const { createTurnGuide } = await import('../src/exercise-tracker.js')
  const guide = createTurnGuide('camera')
  feed(guide, 0, 'right', 0, 1000)
  assert.equal(feed(guide, 60, 'right', 1033, 1100).active, false)
  feed(guide, 0, 'right', 1133, 3000)
  feed(guide, 40, 'right', 3033, 6000)
  assert.equal(feed(guide, 20, 'right', 6033, 9000).active, true)
  assert.equal(feed(guide, 5, 'right', 9033, 12000).active, false)
})

test('side-on exercises are guided towards a 90° turn', async () => {
  const { createTurnGuide } = await import('../src/exercise-tracker.js')
  const guide = createTurnGuide('side')
  assert.equal(feed(guide, 85, 'left', 0, 2000).active, false)
  const halfway = feed(guide, 45, 'left', 2033, 5000)
  assert.equal(halfway.active, true)
  assert.equal(halfway.turn, 'left')
  assert.equal(feed(guide, 2, 'left', 5033, 8000).turn, null)
})

test('drawn joints settle when still, follow movement, and restart after a gap', async () => {
  const { createPointSmoother } = await import('../src/smoothing.js')
  const smoother = createPointSmoother(500)
  let seed = 5
  const jitter = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - .5) * 10
  const xs = []
  for (let t = 0; t < 3000; t += 33) {
    const out = smoother.smooth({ elbow:{ x:400 + jitter(), y:300 + jitter() } }, t)
    if (t > 1000) xs.push(out.elbow.x)
  }
  assert.ok(Math.max(...xs) - Math.min(...xs) < 4)
  let out
  for (let t = 3000; t < 4000; t += 33) out = smoother.smooth({ elbow:{ x:400 + 700 * (t - 3000) / 1000, y:300 } }, t)
  assert.ok(Math.abs(out.elbow.x - (400 + 700 * 967 / 1000)) < 25)
  assert.deepEqual(smoother.smooth({ elbow:{ x:100, y:100 } }, 5000), { elbow:{ x:100, y:100 } })
  assert.equal(smoother.smooth(null, 5033), null)
})

test('dumbbell row measures elbow bend and torso hinge from the side', async () => {
  const { row } = await import('../src/exercises.js')
  const hanging = body({12:[.3,.4],14:[.3,.6],16:[.3,.8],24:[.5,.6]})
  const pulled = body({12:[.3,.4],14:[.45,.45],16:[.35,.6],24:[.5,.6]})
  const upright = body({12:[.5,.3],14:[.5,.5],16:[.5,.7],24:[.5,.6]})
  const metrics = measurePose(hanging,'right',1000,1000,row).metrics
  assert.equal(metrics.elbow,180)
  assert.equal(Math.round(metrics.torsoLean),45)
  assert.ok(measurePose(pulled,'right',1000,1000,row).metrics.elbow < row.rep.target)
  assert.equal(measurePose(upright,'right',1000,1000,row).metrics.torsoLean,0)
})

test('dumbbell row counts a pull and flags rows done standing upright', async () => {
  const { row } = await import('../src/exercises.js')
  const run = torsoLean => {
    const tracker = createTracker(row)
    let result
    for (const [t,elbow] of [[0,170],[160,170],[200,120],[400,80],[560,80],[600,120],[800,170],[960,170]]) {
      result = tracker.update({elbow,torsoLean},t)
    }
    return result
  }
  const hinged = run(45)
  assert.equal(hinged.reps,1)
  assert.equal(hinged.flaggedReps,0)
  assert.equal(hinged.form,'within')
  const upright = run(10)
  assert.equal(upright.reps,1)
  assert.equal(upright.flaggedReps,1)
  assert.deepEqual(upright.messages,[row.formRules[0].message])
})

test('a minimum form rule clears only above its recovery threshold', async () => {
  const { row } = await import('../src/exercises.js')
  const tracker = createTracker(row)
  tracker.update({elbow:170,torsoLean:10},0)
  assert.equal(tracker.update({elbow:170,torsoLean:10},300).form,'warning')
  assert.equal(tracker.update({elbow:170,torsoLean:32},400).form,'warning')
  assert.equal(tracker.update({elbow:170,torsoLean:40},500).form,'within')
  assert.equal(tracker.update({elbow:170,torsoLean:null},550).form,'unassessable')
})

test('seated leg raise measures knee extension and counts a raise', async () => {
  const { seatedLegRaise } = await import('../src/exercises.js')
  const seated = body({12:[.5,.3],24:[.5,.6],26:[.7,.6],28:[.7,.85]})
  const raised = body({12:[.5,.3],24:[.5,.6],26:[.7,.6],28:[.95,.6]})
  assert.deepEqual(measurePose(seated,'right',1000,1000,seatedLegRaise).metrics,{knee:90,torsoLean:0})
  assert.equal(measurePose(raised,'right',1000,1000,seatedLegRaise).metrics.knee,180)
  const tracker = createTracker(seatedLegRaise)
  let result
  for (const [t,knee] of [[0,90],[160,90],[200,140],[400,175],[560,175],[600,140],[800,90],[960,90]]) {
    result = tracker.update({knee,torsoLean:5},t)
  }
  assert.equal(result.reps,1)
  assert.equal(result.flaggedReps,0)
})

test('seated leg raise ignores a half raise and flags leaning back', async () => {
  const { seatedLegRaise } = await import('../src/exercises.js')
  const tracker = createTracker(seatedLegRaise)
  let result
  for (const [t,knee] of [[0,90],[160,90],[300,145],[500,145],[700,90],[900,90]]) result = tracker.update({knee,torsoLean:5},t)
  assert.equal(result.reps,0)
  assert.equal(result.partialReps,1)
  for (const [t,knee] of [[1000,90],[1200,175],[1500,175],[1700,90],[1900,90]]) result = tracker.update({knee,torsoLean:45},t)
  assert.equal(result.reps,1)
  assert.equal(result.flaggedReps,1)
})

test('auto side follows the rowing arm, not the straighter, more visible bracing arm', async () => {
  const { row } = await import('../src/exercises.js')
  const { createSideChooser } = await import('../src/exercise-tracker.js')
  // Side-on with the left side nearer; the far right arm rows, the near left arm is braced straight.
  const arm = (shoulder, elbow, wrist, hip, angle) => {
    const radians = angle*Math.PI/180
    return { [shoulder]:[.5,.4], [elbow]:[.5,.6], [wrist]:[.5+.2*Math.sin(radians),.6-.2*Math.cos(radians)], [hip]:[.8,.4] }
  }
  const frame = rowing => {
    const points = body({...arm(11,13,15,23,172), ...arm(12,14,16,24,rowing)})
    for (const index of [11,13,15,23]) points[index] = {...points[index], z:0, visibility:1}
    for (const index of [12,14,16,24]) points[index] = {...points[index], z:.3, visibility:.85}
    return points
  }
  // Hang, then three rows of 1 s up and 2 s down, then a pause.
  const angles = []
  for (let t = 0; t < 500; t += 33) angles.push([t,170])
  for (let rep = 0; rep < 3; rep++) {
    const from = 500+rep*3500
    for (let t = 0; t < 3500; t += 33) {
      const angle = t < 1000 ? 170-90*t/1000 : t < 3000 ? 80+90*(t-1000)/2000 : 170
      angles.push([from+t,angle])
    }
  }
  for (let t = 11000; t < 16000; t += 33) angles.push([t,170])
  const chooser = createSideChooser(row)
  const tracker = createTracker(row)
  let current = null
  let result
  const seenSides = []
  for (const [t,angle] of angles) {
    const points = frame(angle)
    const side = chooser.update(points, undefined, t, 1000, 1000, current)
    if (side !== current) {
      current = side
      seenSides.push(side)
      tracker.resetSequence()
      for (const { at, value } of chooser.recent(side)) tracker.update({ elbow:value }, at)
    }
    result = tracker.update(measurePose(points, current, 1000, 1000, row)?.metrics, t)
  }
  assert.equal(Math.round(measurePose(frame(80),'right',1000,1000,row).metrics.elbow), 80)
  assert.deepEqual(seenSides, ['left','right'], 'starts on the near arm, switches once, stays through the pause')
  assert.equal(result.reps, 3, 'the rep that revealed the rowing arm is replayed and counted')
})

test('goblet squat counts a deep squat and flags a forward chest sooner than a back squat', async () => {
  const { gobletSquat } = await import('../src/exercises.js')
  const tracker = createTracker(gobletSquat)
  let result
  for (const [t,knee] of [[0,175],[160,175],[300,90],[500,90],[700,175],[900,175]]) result = tracker.update({knee,torsoLean:30},t)
  assert.equal(result.reps,1)
  assert.equal(result.flaggedReps,0)
  for (const [t,knee] of [[1000,175],[1200,110],[1400,110],[1600,175],[1800,175]]) result = tracker.update({knee,torsoLean:30},t)
  assert.equal(result.partialReps,1)
  for (const [t,knee] of [[1900,175],[2100,90],[2400,90],[2600,175],[2800,175]]) result = tracker.update({knee,torsoLean:50},t)
  assert.equal(result.reps,2)
  assert.equal(result.flaggedReps,1)
})

test('dumbbell deadlift measures the hip hinge and flags squatting the weight down', async () => {
  const { deadlift } = await import('../src/exercises.js')
  const standing = body({12:[.5,.2],24:[.5,.5],26:[.5,.7],28:[.5,.9]})
  const hinged = body({12:[.2,.5],24:[.5,.5],26:[.5,.7],28:[.5,.9]})
  assert.deepEqual(measurePose(standing,'right',1000,1000,deadlift).metrics,{hip:180,knee:180})
  assert.equal(measurePose(hinged,'right',1000,1000,deadlift).metrics.hip,90)
  const tracker = createTracker(deadlift)
  let result
  for (const [t,hip] of [[0,175],[160,175],[400,100],[600,100],[900,175],[1100,175]]) result = tracker.update({hip,knee:150},t)
  assert.equal(result.reps,1)
  assert.equal(result.flaggedReps,0)
  for (const [t,hip] of [[1200,175],[1500,100],[1900,100],[2200,175],[2400,175]]) result = tracker.update({hip,knee:hip < 140 ? 95 : 170},t)
  assert.equal(result.reps,2)
  assert.equal(result.flaggedReps,1)
})

test('scaption counts a raise and flags bent elbows and raising above the shoulder', async () => {
  const { scaption } = await import('../src/exercises.js')
  const tracker = createTracker(scaption)
  let result
  for (const [t,raise] of [[0,10],[160,10],[600,85],[800,85],[1600,10],[1800,10]]) result = tracker.update({armRaise:raise,elbow:170},t)
  assert.equal(result.reps,1)
  assert.equal(result.flaggedReps,0)
  for (const [t,raise] of [[1900,10],[2400,85],[2800,85],[3600,10],[3800,10]]) result = tracker.update({armRaise:raise,elbow:120},t)
  assert.equal(result.reps,2)
  assert.equal(result.flaggedReps,1)
  for (const [t,raise] of [[3900,10],[4400,120],[4800,120],[5600,10],[5800,10]]) result = tracker.update({armRaise:raise,elbow:170},t)
  assert.equal(result.reps,3)
  assert.equal(result.flaggedReps,2)
})
