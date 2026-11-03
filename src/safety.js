// Watches for movements that may be unsafe, especially for older users: a sudden
// drop of the body (sitting down hard, or a fall), the body tipping over or vanishing
// right after such a drop, leaning far off balance, a limb whipping or dropping much
// faster than a controlled exercise, and the dumbbell sensor falling freely.
// These are prototype heuristics on visible movement, not a medical fall detector.
//
// Body positions are normalised by torso length (shoulder midpoint to hip midpoint
// in pixels), so thresholds hold at any distance from the camera.

export const SAFETY_KINDS = ['fall', 'drop', 'balance', 'jerk', 'dropped-weight']

export const SAFETY_MESSAGES = {
  fall:'Are you OK? It looks like you may have fallen or lost your balance. Stop and rest. If you are hurt, call for help.',
  drop:'That was a sudden drop. Lower yourself slowly and steadily.',
  balance:'You are leaning a long way. Stand or sit tall and steady. Hold a chair if you need to.',
  jerk:'That movement was very sudden. Slow down and move with control.',
  'dropped-weight':'The dumbbell may have been dropped. Check you are OK before carrying on.',
}

// Short labels for saved-session views.
export const SAFETY_LABELS = {
  fall:'Possible fall', drop:'Sudden drop', balance:'Leaning off balance', jerk:'Sudden jerky movement',
  'dropped-weight':'Dumbbell dropped',
}

const SEVERITY = { fall:'danger', drop:'caution', balance:'caution', jerk:'caution', 'dropped-weight':'caution' }

const DEFAULTS = {
  minVisibility:0.5,
  dropSpeed:2.5,       // torso lengths per second of hip descent that count as a sudden drop
  speedWindowMs:150,   // speeds are measured against a sample at least this old
  maxSampleGapMs:400,  // older baselines are stale (tracking gap), so no speed is measured
  fallWindowMs:1200,   // after a drop, tipping over or vanishing within this long is a possible fall
  fallTilt:65,         // torso degrees from vertical that, after a drop, look like a fall
  lostMs:300,          // how long the body must stay out of view after a drop (one missed frame is noise)
  leanHoldMs:600,
  maxLimbSpeed:360,    // degrees per second of the rep angle; a controlled lift is under ~200
  freeFallAccel:-7,    // m/s², world vertical with gravity removed: free fall reads about -9.8
  freeFallMs:100,
  cooldownMs:6000,     // the same kind of alert is not repeated sooner than this
}

// How far each exercise may lean the torso (degrees from vertical in the image)
// before it looks off balance. Facing the camera this is sideways lean; side-on it is
// forward or backward lean, which hinged exercises do on purpose (null: not checked).
export function leanLimit(profile) {
  if (profile.safety && 'maxLean' in profile.safety) return profile.safety.maxLean
  return profile.facing === 'camera' ? 20 : null
}

function seen(joint, minVisibility) {
  return joint && Number.isFinite(joint.x) && Number.isFinite(joint.y) && (joint.visibility ?? 1) >= minVisibility &&
    joint.x >= 0 && joint.x <= 1 && joint.y >= 0 && joint.y <= 1
}

function midpoint(landmarks, indices, width, height, minVisibility) {
  const points = indices.map(index => landmarks[index]).filter(joint => seen(joint, minVisibility))
  if (!points.length) return null
  return {
    x:points.reduce((sum, joint) => sum + joint.x, 0) / points.length * width,
    y:points.reduce((sum, joint) => sum + joint.y, 0) / points.length * height,
  }
}

// Hip height, torso size and torso tilt from MediaPipe image landmarks, or null when
// neither shoulder or neither hip is visible.
export function bodyFrame(landmarks, width, height, minVisibility = DEFAULTS.minVisibility) {
  if (!landmarks || !(width > 0 && height > 0)) return null
  const shoulders = midpoint(landmarks, [11, 12], width, height, minVisibility)
  const hips = midpoint(landmarks, [23, 24], width, height, minVisibility)
  if (!shoulders || !hips) return null
  const dx = shoulders.x - hips.x
  const dy = hips.y - shoulders.y  // image y points down, so upright is positive
  const torso = Math.hypot(dx, dy)
  if (torso < 1) return null
  return { hipY:hips.y, torso, tilt:Math.atan2(Math.abs(dx), dy) * 180 / Math.PI }
}

// Finds the newest sample at least windowMs old, for a speed over a steady baseline.
function baseline(history, now, windowMs, maxGapMs) {
  for (let i = history.length - 1; i >= 0; i--) {
    const age = now - history[i].t
    if (age >= windowMs) return age <= maxGapMs ? history[i] : null
  }
  return null
}

function trim(history, now, keepMs) {
  while (history.length && now - history[0].t > keepMs) history.shift()
}

export function createSafetyMonitor(profile, options = {}) {
  const config = { ...DEFAULTS, ...options }
  const maxLean = leanLimit(profile)
  let body, limbs, leanSince, dropAt, lostSince, lastAlert, freeFallSince, lastImuT

  function reset() {
    body = []
    limbs = new Map()
    leanSince = null
    dropAt = null
    lostSince = null
    freeFallSince = null
    lastImuT = null
    lastAlert = {}
  }
  reset()

  function raise(kind, now, alerts) {
    if (lastAlert[kind] !== undefined && now - lastAlert[kind] < config.cooldownMs && now >= lastAlert[kind]) return
    lastAlert[kind] = now
    alerts.push({ kind, severity:SEVERITY[kind], message:SAFETY_MESSAGES[kind] })
  }

  function checkLimb(key, value, now, alerts) {
    let limb = limbs.get(key)
    if (!limb) limbs.set(key, limb = { history:[], fastFrames:0 })
    if (!Number.isFinite(value)) {
      limb.history = []
      limb.fastFrames = 0
      return
    }
    const from = baseline(limb.history, now, config.speedWindowMs / 1.5, config.maxSampleGapMs)
    limb.history.push({ t:now, value })
    trim(limb.history, now, config.maxSampleGapMs)
    if (!from) return
    const speed = Math.abs(value - from.value) / ((now - from.t) / 1000)
    // Two fast frames in a row, so a single mis-detected frame does not alert.
    limb.fastFrames = speed > config.maxLimbSpeed ? limb.fastFrames + 1 : 0
    if (limb.fastFrames >= 2) raise('jerk', now, alerts)
  }

  return {
    // frame: { body: bodyFrame(...) or null, limbs: { key: rep angle } } where a key
    // names a limb and its side (a new key starts a new history). Returns new alerts.
    update({ body:frame, limbs:angles = {} }, now) {
      const alerts = []
      if (!Number.isFinite(now)) return alerts
      if (body.length && now < body.at(-1).t) reset()
      const recentDrop = dropAt !== null && now - dropAt <= config.fallWindowMs

      if (!frame) {
        // Vanishing straight after a sudden drop: the person may be on the floor.
        if (lostSince === null) lostSince = recentDrop ? now : -Infinity
        if (lostSince !== -Infinity && now - lostSince >= config.lostMs) {
          raise('fall', now, alerts)
          dropAt = null
          lostSince = -Infinity
        }
        body = []
        leanSince = null
      } else {
        lostSince = null
        const from = baseline(body, now, config.speedWindowMs, config.maxSampleGapMs)
        body.push({ t:now, ...frame })
        trim(body, now, config.maxSampleGapMs)
        if (from) {
          const torso = (from.torso + frame.torso) / 2
          const descent = (frame.hipY - from.hipY) / torso / ((now - from.t) / 1000)
          if (descent > config.dropSpeed) {
            if (dropAt === null) raise('drop', now, alerts)
            dropAt = now
          }
        }
        if (recentDrop && frame.tilt >= config.fallTilt) { raise('fall', now, alerts); dropAt = null }
        if (dropAt !== null && now - dropAt > config.fallWindowMs) dropAt = null

        if (maxLean !== null && frame.tilt > maxLean) {
          leanSince ??= now
          if (now - leanSince >= config.leanHoldMs) raise('balance', now, alerts)
        } else leanSince = null
      }

      for (const [key, value] of Object.entries(angles)) checkLimb(key, value, now, alerts)
      for (const key of limbs.keys()) if (!(key in angles)) limbs.delete(key)
      return alerts
    },
    // sample: a dumbbell sensor sample (src/imu.js). Free fall reads about -g on the
    // world vertical once gravity is removed; a lowered weight rarely passes -3 m/s².
    imu(sample, now) {
      const alerts = []
      if (lastImuT !== null && (sample.t < lastImuT || sample.t - lastImuT > config.maxSampleGapMs)) freeFallSince = null
      lastImuT = sample.t
      if (!sample.still && sample.accel[2] < config.freeFallAccel) {
        freeFallSince ??= sample.t
        if (sample.t - freeFallSince >= config.freeFallMs) {
          raise('dropped-weight', now, alerts)
          freeFallSince = null
        }
      } else freeFallSince = null
      return alerts
    },
    reset,
  }
}
