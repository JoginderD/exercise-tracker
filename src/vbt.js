// Velocity-based training from the dumbbell sensor's world-frame acceleration.
//
// Integrating acceleration drifts (a 1° tilt error is 0.17 m/s² of fake acceleration),
// so velocity is only trusted between points where it is known to be zero: rest, and
// the turnaround at each end of a rep. Over one full rep cycle the weight returns to
// where it started, so the true velocity averages to zero and the moving average of
// the integrated velocity over one cycle is pure drift. Turnarounds are the zero
// crossings of velocity minus that centred average; the window follows the measured
// rep cycle, because a fixed window would shift the crossings of asymmetric reps
// (a 1 s lift and a 2 s lowering). Each phase between turnarounds is re-anchored so
// velocity is zero at both ends, which removes a constant acceleration error exactly:
//   mean velocity = displacement / time, power P = m (g + a) v, work = m g h.
// A concentric (upward) phase is one rep; velocity loss compares it with the fastest
// rep so far in the set, a standard proxy for fatigue; resting for setRestMs starts a
// new set. Results arrive about half a cycle late.

const G = 9.80665
const DEFAULTS = {
  cycleMs:3000,     // assumed rep cycle until two have been seen
  minCycleMs:1000,
  maxCycleMs:8000,
  hysteresis:0.04,  // m/s the detrended velocity must pass to confirm a new direction
  minRomM:0.05,     // shorter movements are wobble, not a phase
  minPhaseMs:250,
  maxPhaseMs:6000,
  pairGapMs:2000,   // longest pause between a lift and its lowering
  movingVelocity:0.03,
  snapMs:150,       // how far from a turnaround a pause may start
  pauseAccel:0.35,  // m/s² below which the weight counts as paused
  minPauseMs:80,  // m/s below which the ends of a phase count as a pause
  restBackdateMs:500,
  setRestMs:15000,  // rest at least this long between sets
}

const round = (value, places) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(places))

function angleBetween(a, b) {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
  return 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI
}

// loadStart says where the weight starts each rep: 'bottom' (curl, press, raise, row:
// lift then lower) or 'top' (squat: lower then lift). massKg may be null, in which
// case power and work are left out.
export function createVbt({ massKg = null, loadStart = 'bottom', lossThresholdPct = 25, ...options } = {}) {
  const config = { ...DEFAULTS, ...options }
  const reps = []
  let interruptions = 0
  let best = 0
  let set = 1
  let restSince = null  // device time the current rest began
  let lastIndex = null
  let periodMs = 10
  let cycleMs = config.cycleMs
  // Current motion segment, since the last rest or data gap.
  let t, az, v, prefix, q, gyro, anchor, sign, cross, checked, previous, lastTurn
  let pending = null  // a lift waiting for its lowering ('bottom'), or a lowering waiting for its lift ('top')

  function clear() {
    t = []; az = []; v = []; prefix = [0]; q = []; gyro = []
    anchor = 0; sign = 0; cross = null; checked = 0; previous = 0
    lastTurn = { up:null, down:null }
  }
  clear()

  const half = () => Math.round(cycleMs / 2 / periodMs)
  // Velocity minus its centred one-cycle average. Around the segment the dumbbell was
  // at rest, so samples out of range count as zero velocity.
  function detrended(j) {
    const h = half()
    const from = Math.max(0, j - h)
    const to = Math.min(v.length - 1, j + h)
    return v[j] - (prefix[to + 1] - prefix[from]) / (2 * h + 1)
  }

  function measure(a, b) {
    if (b - a < 2) return null
    const drift = (v[b] - v[a]) / (t[b] - t[a])  // m/s per ms of accumulated error
    const corrected = k => v[k] - v[a] - drift * (t[k] - t[a])
    // A pause at either end is still part of the phase but not of its timing, so mean
    // velocity is displacement over the time actually moving (as the camera's tempo is).
    let peakAbs = 0
    for (let k = a; k <= b; k++) peakAbs = Math.max(peakAbs, Math.abs(corrected(k)))
    const moving = Math.max(config.movingVelocity, peakAbs * 0.05)
    let first = a
    let lastMoving = b
    while (first < b && Math.abs(corrected(first)) < moving) first++
    while (lastMoving > first && Math.abs(corrected(lastMoving)) < moving) lastMoving--
    const durationMs = t[Math.min(b, lastMoving + 1)] - t[Math.max(a, first - 1)]
    let disp = 0
    let peak = 0
    let powerSum = 0
    let peakPower = 0
    let rotation = 0
    let peakGyro = 0
    let last = 0
    for (let k = a; k <= b; k++) {
      const velocity = corrected(k)
      if (k > a) disp += (last + velocity) / 2 * (t[k] - t[k - 1]) / 1000
      last = velocity
      if (Math.abs(velocity) > Math.abs(peak)) peak = velocity
      if (massKg) {
        const power = massKg * (G + az[k] - drift * 1000) * velocity
        if (k >= first && k <= lastMoving) powerSum += power
        if (Math.abs(power) > Math.abs(peakPower)) peakPower = power
      }
      rotation = Math.max(rotation, angleBetween(q[a], q[k]))
      peakGyro = Math.max(peakGyro, gyro[k])
    }
    if (Math.abs(disp) < config.minRomM || durationMs < config.minPhaseMs || durationMs > config.maxPhaseMs) return null
    return {
      direction:disp > 0 ? 'up' : 'down',
      startT:t[a], endT:t[b], durationMs,
      romM:Math.abs(disp),
      meanVelocity:Math.abs(disp) / (durationMs / 1000),
      peakVelocity:Math.abs(peak),
      meanPowerW:massKg ? Math.abs(powerSum / Math.max(1, lastMoving - first + 1)) : null,
      peakPowerW:massKg ? Math.abs(peakPower) : null,
      rotationDeg:rotation,
      peakGyroDps:peakGyro,
    }
  }

  function emit(lift, lowering, events) {
    best = Math.max(best, lift.meanVelocity)
    const loss = best > 0 ? Math.max(0, (best - lift.meanVelocity) / best * 100) : 0
    const rep = {
      number:reps.length + 1,
      set,
      mcv:round(lift.meanVelocity, 3),
      peakVelocity:round(lift.peakVelocity, 3),
      romCm:round(lift.romM * 100, 1),
      concentricMs:Math.round(lift.durationMs),
      eccentricMs:lowering ? Math.round(lowering.durationMs) : null,
      meanPowerW:round(lift.meanPowerW, 1),
      peakPowerW:round(lift.peakPowerW, 1),
      rotationDeg:round(lift.rotationDeg, 1),
      peakGyroDps:round(lift.peakGyroDps, 1),
      velocityLossPct:round(loss, 1),
    }
    reps.push(rep)
    events.push({ rep, fatigued:reps.length > 1 && loss >= lossThresholdPct })
  }

  function flushPending(events) {
    if (pending?.direction === 'up') emit(pending, null, events)
    pending = null
  }

  function addPhase(phase, events) {
    if (!phase) return
    if (loadStart === 'top') {
      if (phase.direction === 'down') pending = phase
      else {
        const lowering = pending && phase.startT - pending.endT <= config.pairGapMs ? pending : null
        emit(phase, lowering, events)
        pending = null
      }
      return
    }
    if (phase.direction === 'up') {
      flushPending(events)
      pending = phase
    } else if (pending && phase.startT - pending.endT <= config.pairGapMs) {
      emit(pending, phase, events)
      pending = null
    }
  }

  // A turnaround next to a pause moves to the middle of the pause, where velocity and
  // acceleration are truly zero; at a bounce, a boundary just 20 ms off sits on 3 m/s²
  // and skews the phase's displacement by several percent. The pause test allows for
  // the phase's own drift (its mean acceleration error) and smooths over 50 ms of noise.
  function snapToPause(turn) {
    const reach = Math.round(config.snapMs / periodMs)
    const drift = turn > anchor ? (v[turn] - v[anchor]) / (t[turn] - t[anchor]) * 1000 : 0
    const smooth = k => {
      let sum = 0
      let count = 0
      for (let i = Math.max(0, k - 2); i <= Math.min(az.length - 1, k + 2); i++) { sum += az[i]; count++ }
      return sum / count
    }
    const quiet = k => Math.abs(smooth(k) - drift) < config.pauseAccel
    // The quiet run touching the turnaround's neighbourhood, if any.
    let start = -1
    for (let k = Math.max(anchor + 1, turn - reach); k <= Math.min(az.length - 1, turn + reach); k++) {
      if (quiet(k)) { start = k; break }
    }
    if (start < 0) return turn
    let end = start
    while (start > anchor + 1 && start > turn - 3 * reach && quiet(start - 1)) start--
    while (end < az.length - 1 && end < turn + 3 * reach && quiet(end + 1)) end++
    return (end - start + 1) * periodMs >= config.minPauseMs ? Math.round((start + end) / 2) : turn
  }

  // Looks for a turnaround at sample j, once its window is available.
  function check(j, events) {
    const now = detrended(j)
    if ((previous <= 0 && now > 0) || (previous >= 0 && now < 0)) cross = j - 1 + previous / (previous - now)
    previous = now
    if (sign === 0) {
      // Just after rest the raw velocity has had no time to drift, and the centred
      // average would see the coming movement early, so the first direction comes from v.
      if (Math.abs(v[j]) > config.hysteresis) { sign = Math.sign(v[j]); cross = null }
      return
    }
    if (Math.sign(now) !== -sign || Math.abs(now) <= config.hysteresis || cross === null) return
    const turn = snapToPause(Math.round(cross))
    // The spacing of same-kind turnarounds (top to top, bottom to bottom) is the rep cycle.
    const kind = sign > 0 ? 'up' : 'down'
    const turnMs = t[turn]
    if (lastTurn[kind] !== null) {
      cycleMs = Math.min(config.maxCycleMs, Math.max(config.minCycleMs, turnMs - lastTurn[kind]))
    }
    lastTurn[kind] = turnMs
    if (turn > anchor) {
      addPhase(measure(anchor, turn), events)
      anchor = turn
    }
    sign = -sign
    rebase()
  }

  // Ends the segment at rest: the last phase finishes where the motion stopped, which
  // the 0.3 s stillness flag reports late.
  // The turnarounds still inside the detection delay are found from velocity detrended
  // between the two known zeros, the last turnaround and the rest.
  function endAtRest(events) {
    let end = v.length - 1
    const stopBy = t[end] - config.restBackdateMs
    while (end > anchor + 1 && t[end] > stopBy && gyro[end] < 8 && Math.abs(az[end]) < 0.4) end--
    if (end > anchor) {
      const start = anchor
      const slope = (v[end] - v[start]) / (t[end] - t[start])
      const corrected = k => v[k] - v[start] - slope * (t[k] - t[start])
      let direction = 0
      let last = 0
      let zero = null
      for (let k = start + 1; k <= end; k++) {
        const now = corrected(k)
        if ((last <= 0 && now > 0) || (last >= 0 && now < 0)) zero = k - 1 + last / (last - now)
        last = now
        if (Math.abs(now) <= config.hysteresis) continue
        if (direction !== 0 && Math.sign(now) === -direction && zero !== null) {
          const turn = snapToPause(Math.round(zero))
          if (turn > anchor && turn < end) {
            addPhase(measure(anchor, turn), events)
            anchor = turn
          }
        }
        direction = Math.sign(now)
      }
      addPhase(measure(anchor, end), events)
    }
    flushPending(events)
    clear()
  }

  // Drops samples the analysis can no longer reach, so a long set stays bounded.
  function rebase() {
    const drop = Math.min(anchor, checked) - Math.round(config.maxCycleMs / periodMs) - 2
    if (drop < 2000) return
    for (const list of [t, az, v, q, gyro]) list.splice(0, drop)
    prefix = [0]
    for (const value of v) prefix.push(prefix.at(-1) + value)
    anchor -= drop
    checked -= drop
    if (cross !== null) cross -= drop
  }

  return {
    // sample: { index, t (ms), q:[w,x,y,z], accel:[x,y,z] m/s² world with gravity removed,
    // gyro:[x,y,z] °/s, still }. Returns finished reps as { rep, fatigued } events.
    push(sample) {
      const events = []
      const next = lastIndex !== null && sample.index === lastIndex + 1
      if (lastIndex !== null && !next) {
        // Lost samples break the integration; the phase in progress cannot be measured.
        if (v.length) interruptions++
        pending = null
        clear()
      }
      if (next && t.length && sample.t > t.at(-1)) periodMs = sample.t - t.at(-1)
      lastIndex = sample.index
      if (sample.still) {
        if (v.length) endAtRest(events)
        restSince ??= sample.t
        if (best > 0 && sample.t - restSince >= config.setRestMs) { set++; best = 0 }
        return events
      }
      restSince = null
      const n = v.length
      const velocity = n ? v[n - 1] + (az[n - 1] + sample.accel[2]) / 2 * (sample.t - t[n - 1]) / 1000 : 0
      t.push(sample.t); az.push(sample.accel[2]); v.push(velocity); q.push(sample.q)
      gyro.push(Math.hypot(...sample.gyro))
      prefix.push(prefix[n] + velocity)
      while (checked < v.length - 1 - half()) check(++checked, events)
      return events
    },
    // Ends the run. If the dumbbell has come to rest (held still in the hand) the
    // movement so far is measured; if it is still moving, velocity is not zero and the
    // unfinished movement would measure as nonsense, so only completed lifts are kept.
    finish() {
      const events = []
      const quietFrom = t.length ? t.at(-1) - config.restBackdateMs : 0
      let quiet = t.length > 0
      for (let k = t.length - 1; quiet && k >= 0 && t[k] >= quietFrom; k--) quiet = gyro[k] < 8 && Math.abs(az[k]) < 0.4
      if (quiet) endAtRest(events)
      else {
        flushPending(events)
        clear()
      }
      lastIndex = null
      return events
    },
    report() {
      return { massKg, lossThresholdPct, interruptions, reps:reps.slice() }
    },
  }
}

// Set-level numbers from saved reps. Shared with the server, so stored sessions are
// summarised the same way everywhere.
export function summariseImu(imu) {
  const reps = imu?.reps ?? []
  if (!reps.length) return null
  const velocities = reps.map(rep => rep.mcv)
  const powers = reps.map(rep => rep.peakPowerW).filter(Number.isFinite)
  const romTotal = reps.reduce((sum, rep) => sum + rep.romCm, 0) / 100
  return {
    reps:reps.length,
    bestMcv:Math.max(...velocities),
    meanMcv:round(velocities.reduce((a, b) => a + b, 0) / reps.length, 3),
    finalLossPct:reps.at(-1).velocityLossPct,
    maxLossPct:Math.max(...reps.map(rep => rep.velocityLossPct)),
    peakPowerW:powers.length ? Math.max(...powers) : null,
    totalWorkJ:imu.massKg ? round(imu.massKg * G * romTotal, 1) : null,
  }
}
