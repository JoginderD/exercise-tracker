// Decides whether the Curl Guard link is healthy. Pure logic with no page code,
// so it is easy to test. guard-panel.js shows the result and plays the sound.
//
// A problem is reported when:
//   lost      the Bluetooth link dropped and the user did not press Disconnect
//   bad-data  several packets in a row were broken or physically impossible
//   stalled   the link is open but no good packet arrived for a while

// The firmware measures +-8 g and +-1000 deg/s, so anything clearly beyond that is garbage.
// A little margin is allowed so a reading right at the limit is not rejected.
const MAX_ACCEL_G = 8.5
const MAX_GYRO_DPS = 1100
const BAD_LIMIT = 3       // this many bad packets in a row count as a problem
const STALE_MS = 1500     // the guard sends about 25 packets/s, so 1.5 s of silence is a fault

export const PROBLEM_MESSAGES = {
  lost: 'The Bluetooth connection to the device was lost.',
  'bad-data': 'The device is sending data that does not make sense.',
  stalled: 'The device is connected but has stopped sending data.',
}

// True when every reading is inside what the sensor can really produce.
export function isPlausible(packet) {
  const accel = [packet.ax, packet.ay, packet.az]
  const gyro = [packet.gx, packet.gy, packet.gz]
  return accel.every(v => Number.isFinite(v) && Math.abs(v) <= MAX_ACCEL_G)
      && gyro.every(v => Number.isFinite(v) && Math.abs(v) <= MAX_GYRO_DPS)
}

// now() is injectable so the tests do not have to wait for real time.
export function createGuardHealth({ now = () => Date.now() } = {}) {
  let active = false        // true while a link is open
  let userClosing = false   // true after the user pressed Disconnect
  let badInARow = 0
  let lastGoodAt = 0
  let problem = null        // null or { code, message }
  let dismissed = false     // the user silenced the current problem

  function raise(code) {
    if (problem?.code === code) return
    problem = { code, message: PROBLEM_MESSAGES[code] }
    dismissed = false
  }
  function clear() {
    problem = null
    dismissed = false
  }

  return {
    // The link is up: start watching for data.
    linkUp() {
      active = true
      userClosing = false
      badInARow = 0
      lastGoodAt = now()
      clear()
    },
    // Call just before the user's own disconnect so it is not reported as a fault.
    userDisconnecting() { userClosing = true },
    // The link went down. Only a link that was up and not closed by the user is a problem.
    linkDown() {
      const unexpected = active && !userClosing
      active = false
      userClosing = false
      badInARow = 0
      if (unexpected) raise('lost')
      else clear()
    },
    // A packet was decoded. Checks it and counts good and bad ones.
    packet(packet) {
      if (!active) return
      if (isPlausible(packet)) {
        badInARow = 0
        lastGoodAt = now()
        if (problem && problem.code !== 'lost') clear()  // recovered by itself
      } else {
        this.badPacket()
      }
    },
    // A packet could not be decoded at all (for example too short), or was implausible.
    badPacket() {
      if (!active) return
      badInARow++
      if (badInARow >= BAD_LIMIT) raise('bad-data')
    },
    // Call regularly (a few times per second). Detects a silent link.
    tick() {
      if (active && !problem && now() - lastGoodAt > STALE_MS) raise('stalled')
      return problem
    },
    // The user pressed Silence: hide the warning and stop the sound until something changes.
    dismiss() { dismissed = true },
    get problem() { return problem },
    get dismissed() { return dismissed },
    // True while the warning should be on screen and the sound should repeat.
    get alerting() { return Boolean(problem) && !dismissed },
  }
}