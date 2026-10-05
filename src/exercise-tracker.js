function angleAt(a, b, c) {
  const u = [a.x-b.x,a.y-b.y]
  const v = [c.x-b.x,c.y-b.y]
  const length = Math.hypot(...u)*Math.hypot(...v)
  if (length < 0.000001) return null
  return Math.acos(Math.max(-1,Math.min(1,(u[0]*v[0]+u[1]*v[1])/length)))*180/Math.PI
}

export function measurePose(landmarks, side, width, height, profile) {
  if (!landmarks || !(width > 0 && height > 0)) return null
  const points = {}
  for (const [name,index] of Object.entries(profile.landmarks[side])) {
    const joint = landmarks[index]
    if (!joint || !Number.isFinite(joint.x) || !Number.isFinite(joint.y) ||
      !(joint.visibility >= profile.minVisibility) ||
      joint.x < 0 || joint.x > 1 || joint.y < 0 || joint.y > 1) return null
    points[name] = { x:joint.x*width, y:joint.y*height }
  }
  const metrics = {}
  for (const [name,joints] of Object.entries(profile.metrics)) {
    metrics[name] = angleAt(...joints.map(joint => points[joint]))
    if (metrics[name] === null) return null
  }
  return {points,metrics}
}

export function createTracker(profile) {
  let reps = 0
  let flaggedReps = 0
  let phase, heldPosition, positionSince, lastTime, repFlagged, rules

  function resetSequence() {
    phase = 'waiting'
    heldPosition = null
    positionSince = 0
    lastTime = null
    repFlagged = false
    rules = profile.formRules.map(() => ({since:null,active:false}))
  }
  resetSequence()

  function update(metrics, now) {
    const required = [profile.rep.metric, ...profile.formRules.map(rule => rule.metric)]
    if (!metrics || !Number.isFinite(now) || required.some(key => !Number.isFinite(metrics[key]))) {
      resetSequence()
      return {reps,flaggedReps,form:'unassessable',messages:[]}
    }
    if (lastTime !== null && (now-lastTime > profile.maxGapMs || now < lastTime)) resetSequence()
    lastTime = now

    const messages = []
    let pending = false
    profile.formRules.forEach((rule,index) => {
      const state = rules[index]
      const value = metrics[rule.metric]
      if (state.active) {
        if (value <= rule.clearBelow) { state.active=false; state.since=null }
      } else if (value > rule.max) {
        if (state.since === null) state.since=now
        if (now-state.since >= rule.holdMs) state.active=true
        else pending=true
      } else state.since=null
      if (state.active) messages.push(rule.message)
    })
    if (phase !== 'waiting' && messages.length) repFlagged = true

    const rep = profile.rep
    const angle = metrics[rep.metric]
    const atStart = rep.direction === 'increasing' ? angle <= rep.start : angle >= rep.start
    const atTarget = rep.direction === 'increasing' ? angle >= rep.target : angle <= rep.target
    const position = atStart ? 'start' : atTarget ? 'target' : 'between'
    if (position !== heldPosition) {
      heldPosition = position
      positionSince = now
    } else if (now-positionSince >= rep.holdMs) {
      if (phase === 'waiting' && position === 'start') {
        phase = 'ready'
        repFlagged = messages.length > 0
      } else if (phase === 'ready' && position === 'target') {
        phase = 'returning'
      } else if (phase === 'returning' && position === 'start') {
        reps++
        if (repFlagged) flaggedReps++
        phase = 'ready'
        repFlagged = messages.length > 0
      }
    }
    return {reps,flaggedReps,form:messages.length ? 'warning' : pending ? 'pending' : 'within',messages}
  }
  return {update,resetSequence}
}
