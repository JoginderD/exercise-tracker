import { createOneEuroFilter } from './smoothing.js'

const VERTICAL = [0,-1,0]

function vector(from, to) {
  return [to.x-from.x, to.y-from.y, (to.z ?? 0)-(from.z ?? 0)]
}

function angleBetween(u, v) {
  const length = Math.hypot(...u)*Math.hypot(...v)
  if (length < 0.000001) return null
  return Math.acos(Math.max(-1,Math.min(1,(u[0]*v[0]+u[1]*v[1]+u[2]*v[2])/length)))*180/Math.PI
}

function metricAt(definition, points) {
  if (Array.isArray(definition)) {
    const [a,b,c] = definition.map(joint => points[joint])
    return angleBetween(vector(b,a), vector(b,c))
  }
  const [from,to] = definition.segment.map(joint => points[joint])
  return angleBetween(vector(from,to), VERTICAL)
}

function usable(joint) {
  return joint && Number.isFinite(joint.x) && Number.isFinite(joint.y)
}

function seen(joint, profile) {
  return usable(joint) && joint.visibility >= profile.minVisibility &&
    joint.x >= 0 && joint.x <= 1 && joint.y >= 0 && joint.y <= 1
}

const jointsOf = definition => Array.isArray(definition) ? definition : definition.segment

// Names of this side's joints that are hidden or out of frame (all of them with no pose).
export function hiddenJoints(landmarks, side, profile) {
  return Object.entries(profile.landmarks[side])
    .filter(([,index]) => !seen(landmarks?.[index], profile))
    .map(([name]) => name)
}

// Image y points down, as does MediaPipe's world y, so "vertical" assumes a level camera.
// World landmarks are metric 3D (metres, hip-centred), so their angles do not shrink
// when a limb moves towards or away from the camera; 2D pixels are the fallback.
// Only the rep metric's joints are required: a hidden hip leaves the form metric
// null but the rep is still counted.
export function measurePose(landmarks, side, width, height, profile, worldLandmarks) {
  if (!landmarks || !(width > 0 && height > 0)) return null
  const points = {}
  let world = worldLandmarks ? {} : null
  for (const [name,index] of Object.entries(profile.landmarks[side])) {
    const joint = landmarks[index]
    if (!seen(joint, profile)) continue
    points[name] = { x:joint.x*width, y:joint.y*height }
    const spatial = worldLandmarks?.[index]
    if (world && usable(spatial) && Number.isFinite(spatial.z)) world[name] = { x:spatial.x, y:spatial.y, z:spatial.z }
    else world = null
  }
  const space = world ?? points
  const metrics = {}
  for (const [name,definition] of Object.entries(profile.metrics)) {
    metrics[name] = jointsOf(definition).every(joint => space[joint]) ? metricAt(definition, space) : null
  }
  if (metrics[profile.rep.metric] === null) return null
  return {points,metrics,space:world ? '3d' : '2d'}
}

function sideScore(landmarks, side, profile) {
  let score = 1
  for (const index of Object.values(profile.landmarks[side])) {
    const joint = landmarks[index]
    if (!usable(joint) || joint.x < 0 || joint.x > 1 || joint.y < 0 || joint.y > 1) return 0
    score = Math.min(score, joint.visibility ?? 0)
  }
  return score
}

// Picks the side whose weakest joint is most visible. The current side is kept
// unless the other side is clearly better, so the tracked limb does not flicker.
export function chooseSide(landmarks, profile, current, margin = 0.1) {
  if (!landmarks) return current
  const left = sideScore(landmarks, 'left', profile)
  const right = sideScore(landmarks, 'right', profile)
  if (current) {
    const own = current === 'left' ? left : right
    const other = current === 'left' ? right : left
    if (own >= profile.minVisibility && other <= own + margin) return current
  }
  return left >= right ? 'left' : 'right'
}

// Body yaw from the shoulder and hip lines: 0° facing the camera, 90° side-on.
// z grows away from the camera, so the side with the larger z is the far side.
// Works on world landmarks (metres) or image landmarks (z on the x scale).
const TORSO_PAIRS = [[11,12],[23,24]]
export function bodyTurn(landmarks) {
  let dx = 0
  let dz = 0
  let pairs = 0
  for (const [left,right] of TORSO_PAIRS) {
    const a = landmarks?.[left]
    const b = landmarks?.[right]
    if (!usable(a) || !usable(b) || !Number.isFinite(a.z) || !Number.isFinite(b.z)) continue
    dx += b.x-a.x
    dz += b.z-a.z
    pairs++
  }
  if (!pairs || (dx === 0 && dz === 0)) return null
  return {yaw:Math.atan2(Math.abs(dz),Math.abs(dx))*180/Math.PI, far:dz > 0 ? 'right' : 'left'}
}

// Coaches the user into the stance the exercise is measured from: facing 'camera'
// wants ~0° of turn, 'side' wants ~90°. Off by more than the camera tolerates, the
// far limbs are guessed by the model, so angles get squashed and reps are missed.
// The depth estimate is noisy, so the turn is smoothed, must stay off for holdMs
// before warning, and must come back under clearAt before the warning clears.
// "turn" is in the user's own frame: right shoulder further away means they have
// turned to their right, so they should turn to their left to face the camera.
export function createTurnGuide(facing, { warnAt = 25, clearAt = 15, holdMs = 500, maxGapMs = 1000 } = {}) {
  let filter, since, active, lastTime
  function reset() {
    filter = createOneEuroFilter({ minCutoff:0.5, beta:0.01 })
    since = null
    active = false
    lastTime = null
  }
  reset()
  return {
    update(turn, now) {
      if (!turn || !Number.isFinite(now)) return {active,deviation:null,turn:null}
      if (lastTime !== null && (now-lastTime > maxGapMs || now < lastTime)) reset()
      lastTime = now
      const raw = facing === 'side' ? 90-turn.yaw : turn.yaw
      const deviation = filter.filter(raw, now)
      if (active) {
        if (deviation <= clearAt) { active = false; since = null }
      } else if (deviation >= warnAt) {
        since ??= now
        if (now-since >= holdMs) active = true
      } else since = null
      // Barely turned, the far side is noise: a side-on stance can be reached either way.
      const opposite = turn.far === 'right' ? 'left' : 'right'
      const direction = facing === 'side' ? (turn.yaw < 10 ? null : turn.far) : opposite
      return {active,deviation,turn:direction}
    },
    reset,
  }
}

// A rep is start -> target -> start, each position held for rep.holdMs.
// Tempo is timed between turning points rather than threshold crossings: the lift
// runs from leaving the bottom to arriving at the top, the lowering from leaving
// the top to arriving back at the bottom, so pauses at either end are not counted.
// A turning point is the first/last frame within SETTLE_DEGREES of a zone's extreme.
const SETTLE_DEGREES = 6
// The lowering only ends once the arm stops extending, so its verdict waits this long.
const SETTLE_MS = 250
// Leaving a position by this fraction of the start-target span is a rep attempt.
const ATTEMPT_FRACTION = 0.4

export function createTracker(profile) {
  const rep = profile.rep
  const tempo = profile.tempo
  // Signed so that larger always means further towards the rep target.
  const progress = angle => rep.direction === 'increasing' ? angle : -angle
  const minTravel = Math.abs(rep.start-rep.target)*ATTEMPT_FRACTION
  let reps = 0
  let flaggedReps = 0
  let partialReps = 0
  let fastReps = 0
  let slowReps = 0
  let lastRep = null
  let phase, heldPosition, positionSince, lastTime, repFlagged, rules
  let dwell, excursion, liftFrom, liftMs, unsettled

  function resetSequence() {
    // A finished rep keeps its verdict even if tracking stops before the arm settles.
    if (unsettled) settleRep()
    phase = 'waiting'
    heldPosition = null
    positionSince = 0
    lastTime = null
    repFlagged = false
    rules = profile.formRules.map(() => ({since:null,active:false}))
    dwell = null
    excursion = null
    liftFrom = null
    liftMs = null
    unsettled = null
  }

  function summary(form, messages, tempoMessage = null) {
    return {reps,flaggedReps,partialReps,fastReps,slowReps,lastRep,waiting:phase === 'waiting',form,messages,tempoMessage}
  }

  function travelled(trip) {
    return trip.from === 'start'
      ? trip.peak-progress(rep.start) >= minTravel
      : progress(rep.target)-trip.peak >= minTravel
  }

  function judgeTempo(lift, lower) {
    const messages = []
    if (lift < tempo.minLiftMs) messages.push(tempo.messages.fastLift)
    if (lower < tempo.minLowerMs) messages.push(tempo.messages.fastLower)
    if (messages.length) return {verdict:'fast',messages}
    if (lift > tempo.maxPhaseMs || lower > tempo.maxPhaseMs) return {verdict:'slow',messages:[tempo.messages.slow]}
    return {verdict:'good',messages:[]}
  }

  // Called once the arm has come to rest at the bottom (or set off again).
  function settleRep() {
    const lowerMs = dwell.arriveAt-unsettled.lowerFrom
    const judged = tempo ? judgeTempo(unsettled.liftMs, lowerMs) : {verdict:null,messages:[]}
    if (judged.verdict === 'fast') fastReps++
    if (judged.verdict === 'slow') slowReps++
    lastRep = {kind:'full',number:unsettled.number,liftMs:unsettled.liftMs,lowerMs,tempo:judged.verdict,messages:judged.messages}
    unsettled = null
  }

  function partial(trip, message) {
    partialReps++
    lastRep = {kind:'partial',missed:trip.from === 'start' ? 'target' : 'start',
      reached:rep.direction === 'increasing' ? trip.peak : -trip.peak,messages:[message]}
  }

  resetSequence()

  function update(metrics, now) {
    // Missing frames keep the unfinished rep; the gap check below discards it
    // once tracking has been lost for longer than maxGapMs.
    if (!metrics || !Number.isFinite(now) || !Number.isFinite(metrics[rep.metric])) {
      return summary('unassessable', [])
    }
    if (lastTime !== null && (now-lastTime > profile.maxGapMs || now < lastTime)) resetSequence()
    lastTime = now

    const messages = []
    let pending = false
    let unchecked = false
    profile.formRules.forEach((rule,index) => {
      const state = rules[index]
      const value = metrics[rule.metric]
      // A rule whose joints are hidden cannot warn, and must not stay stuck on.
      if (!Number.isFinite(value)) { state.active=false; state.since=null; unchecked=true; return }
      const upper = rule.max !== undefined
      if (state.active) {
        if (upper ? value <= rule.clearBelow : value >= rule.clearAbove) { state.active=false; state.since=null }
      } else if (upper ? value > rule.max : value < rule.min) {
        if (state.since === null) state.since=now
        if (now-state.since >= rule.holdMs) state.active=true
        else pending=true
      } else state.since=null
      if (state.active) messages.push(rule.message)
    })
    if (phase !== 'waiting' && messages.length) repFlagged = true

    const value = progress(metrics[rep.metric])
    const position = value <= progress(rep.start) ? 'start' : value >= progress(rep.target) ? 'target' : 'between'
    if (position !== heldPosition) {
      if (heldPosition === 'start' && phase === 'ready') {
        if (unsettled) settleRep()
        excursion = {from:'start',leftAt:dwell.departAt,peak:value}
      } else if (heldPosition === 'target' && phase === 'returning') {
        // Only the first visit to the top ends the lift; later ones follow partial lowerings.
        liftMs ??= dwell.arriveAt-liftFrom
        excursion = {from:'target',leftAt:dwell.departAt,peak:value}
      }
      dwell = position === 'between' ? null : {arriveAt:now,arriveDepth:null,deepest:-Infinity,departAt:now}
      heldPosition = position
      positionSince = now
    }
    if (dwell) {
      // Depth grows away from the "between" band: down at the start, up at the target.
      const depth = position === 'start' ? -value : value
      dwell.deepest = Math.max(dwell.deepest, depth)
      if (dwell.arriveDepth === null || dwell.deepest-dwell.arriveDepth > SETTLE_DEGREES) {
        dwell.arriveAt = now
        dwell.arriveDepth = depth
      }
      if (dwell.deepest-depth <= SETTLE_DEGREES) dwell.departAt = now
    }
    if (excursion && position === 'between') {
      excursion.peak = excursion.from === 'start' ? Math.max(excursion.peak,value) : Math.min(excursion.peak,value)
    }

    if (position === heldPosition && now-positionSince >= rep.holdMs) {
      if (phase === 'waiting' && position === 'start') {
        phase = 'ready'
        repFlagged = messages.length > 0
      } else if (phase === 'ready' && position === 'target') {
        phase = 'returning'
        liftFrom = excursion.leftAt
        excursion = null
      } else if (phase === 'ready' && position === 'start' && excursion) {
        if (travelled(excursion)) partial(excursion, rep.cues?.target ?? 'Partial rep: not counted.')
        excursion = null
      } else if (phase === 'returning' && position === 'target' && excursion) {
        if (travelled(excursion)) partial(excursion, rep.cues?.start ?? 'Partial rep: not counted.')
        excursion = null
      } else if (phase === 'returning' && position === 'start') {
        reps++
        if (repFlagged) flaggedReps++
        unsettled = {number:reps,liftMs,lowerFrom:excursion.leftAt}
        phase = 'ready'
        repFlagged = messages.length > 0
        excursion = null
        liftFrom = null
        liftMs = null
      }
    }
    if (unsettled && position === 'start' && now-dwell.arriveAt >= SETTLE_MS) settleRep()

    let tempoMessage = null
    if (tempo && excursion && position === 'between' && now-excursion.leftAt > tempo.maxPhaseMs && travelled(excursion)) {
      tempoMessage = tempo.messages.stalled
    }
    return summary(messages.length ? 'warning' : pending ? 'pending' : unchecked ? 'unassessable' : 'within', messages, tempoMessage)
  }
  return {update,resetSequence}
}
