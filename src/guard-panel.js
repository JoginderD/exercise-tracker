// Curl Guard panel: connect button, alarm banner, battery and a live readout.
// Self-contained, so main.js only needs a placeholder <section> and one call.
import './guard-panel.css'
import { createAlarmSound } from './alarm-sound.js'
import { createFusion } from './guard-fusion.js'
import { createGuardHealth, isPlausible } from './guard-health.js'
import { createGuardLink } from './guard.js'
import { bluetoothUnavailable } from './imu.js'

const ALARM_HOLD_MS = 2000  // the firmware flags an alarm in one packet only, so keep it on screen
const FAULT_SOUND_EVERY_MS = 2000  // how often the warning chime repeats while a fault is showing

// root: the <section> to fill. onPacket(packet): optional hook, e.g. for a live graph.
export function createGuardPanel(root, { onPacket } = {}) {
  root.innerHTML = `
    <h2 id="guard-title">Curl guard</h2>
    <p class="hint guard-status" role="status"></p>
    <div class="button-row"><button type="button" class="guard-connect">Connect guard</button></div>
    <p class="guard-alarm" aria-live="polite"></p>
    <div class="button-row guard-sound">
      <label><input type="checkbox" class="guard-sound-on" checked> Alarm sound</label>
      <button type="button" class="guard-sound-test">Test sound</button>
    </div>
    <dl class="guard-readout">
      <div><dt>Battery</dt><dd class="guard-battery">–</dd></div>
      <div><dt>Packets</dt><dd class="guard-rate">–</dd></div>
      <div><dt>Acceleration</dt><dd class="guard-accel">–</dd></div>
      <div><dt>Rotation</dt><dd class="guard-gyro">–</dd></div>
    </dl>
    <p class="guard-check" data-state="" role="status"></p>
    <h3 class="guard-reps-title">Sensor data for each rep the camera counts</h3>
    <ol class="guard-reps"></ol>
    <p class="hint">A small sensor on the dumbbell. It flags a curl that is too fast or a dumbbell that is dropped
    and reports its battery level. This page shows the alarm and plays a warning sound when a curl is too fast.</p>`

  const $ = selector => root.querySelector(selector)
  const statusEl = $('.guard-status')
  const connectButton = $('.guard-connect')
  const alarmEl = $('.guard-alarm')
  const batteryEl = $('.guard-battery')
  const rateEl = $('.guard-rate')
  const accelEl = $('.guard-accel')
  const gyroEl = $('.guard-gyro')
  const checkEl = $('.guard-check')
  const repsEl = $('.guard-reps')
  const soundOn = $('.guard-sound-on')
  const soundTest = $('.guard-sound-test')

  const sound = createAlarmSound()
  const health = createGuardHealth()
  const fusion = createFusion()
  let shownReps = ''  // key of the rep list on screen, so it is only rebuilt when it changes

  // Full-width warning at the top of the page, so it is seen wherever the user has scrolled to.
  const faultEl = root.ownerDocument.createElement('div')
  faultEl.className = 'guard-fault'
  faultEl.setAttribute('role', 'alert')
  faultEl.hidden = true
  faultEl.innerHTML = `
    <div class="guard-fault-text">
      <strong>Your Bluetooth device seems to have a problem.</strong>
      <span class="guard-fault-detail"></span>
    </div>
    <div class="guard-fault-buttons">
      <button type="button" class="guard-fault-reconnect">Reconnect</button>
      <button type="button" class="guard-fault-dismiss">Silence</button>
    </div>`
  root.ownerDocument.body.append(faultEl)
  const faultDetail = faultEl.querySelector('.guard-fault-detail')
  const faultReconnect = faultEl.querySelector('.guard-fault-reconnect')
  const faultDismiss = faultEl.querySelector('.guard-fault-dismiss')
  let lastFaultSoundAt = 0
  if (!sound.available) $('.guard-sound').hidden = true  // very old browser: no Web Audio

  const guard = {
    state: 'disconnected', name: null, error: null, connecting: false,
    packet: null, count: 0, rate: 0, alarm: null, alarmAt: 0,
  }
  let timers = []

  function render() {
    const unavailable = bluetoothUnavailable()
    const connected = guard.state === 'connected'
    const busy = guard.connecting || guard.state === 'connecting'

    let text
    if (unavailable) text = unavailable
    else if (busy) text = 'Connecting to the guard…'
    else if (!connected) text = guard.error ?? 'Not connected. Switch the guard on and press Connect guard.'
    else if (!guard.packet) text = `Connected to ${guard.name}. Waiting for data…`
    else text = `Connected to ${guard.name}.`
    statusEl.textContent = text

    connectButton.disabled = Boolean(unavailable) || busy
    connectButton.textContent = connected ? 'Disconnect guard' : busy ? 'Connecting…' : 'Connect guard'

    const packet = connected ? guard.packet : null
    const alarmActive = connected && guard.alarm && Date.now() - guard.alarmAt < ALARM_HOLD_MS
    alarmEl.dataset.state = !connected ? '' : alarmActive ? 'warning' : 'ok'
    alarmEl.textContent = !connected ? '' : alarmActive ? guard.alarm : 'No alarm'

    batteryEl.textContent = !packet ? '–' : packet.battery === null ? 'n/a' : `${packet.battery} %`
    rateEl.textContent = !packet ? '–' : `${guard.rate} /s`
    accelEl.textContent = !packet ? '–' : `${Math.hypot(packet.ax, packet.ay, packet.az).toFixed(2)} g`
    gyroEl.textContent = !packet ? '–' : `${Math.round(Math.hypot(packet.gx, packet.gy, packet.gz))} °/s`
  }

  function startTimers() {
    stopTimers()
    timers = [
      setInterval(render, 100),                                       // refresh the readout
      setInterval(() => { guard.rate = guard.count; guard.count = 0 }, 1000),  // packets per second
    ]
  }
  function stopTimers() {
    timers.forEach(clearInterval)
    timers = []
  }

  const link = createGuardLink({
    onState(event) {
      if (event.state === 'error') {  // one bad packet: remember the message, keep the link
        guard.error = event.error.message
        health.badPacket()
        return
      }
      guard.state = event.state
      guard.name = event.device
      if (event.state === 'connected') {
        guard.error = null
        guard.count = guard.rate = 0
        health.linkUp()
        startTimers()
      } else if (event.state === 'disconnected') {
        stopTimers()
        health.linkDown()  // a fault unless the user pressed Disconnect
        guard.packet = null
        guard.alarm = null
      }
      render()
    },
    onPacket(packet) {
      health.packet(packet)
      if (!isPlausible(packet)) return  // impossible numbers: do not show them or raise alarms from them
      guard.packet = packet
      fusion.imu(packet, performance.now())  // same clock as the camera frames
      guard.count++
      if (packet.fast) sound.play()  // beeps; ignored while muted or if another alarm just sounded
      if (packet.fast || packet.drop) {
        guard.alarm = [packet.fast && 'Too fast', packet.drop && 'Drop detected'].filter(Boolean).join(' + ')
        guard.alarmAt = Date.now()
      }
      onPacket?.(packet)
    },
  })

  soundOn.addEventListener('change', () => { sound.muted = !soundOn.checked })
  soundTest.addEventListener('click', () => {
    sound.unlock()
    sound.play()
  })

  // Text for one rep line: what the sensor felt while the camera counted that rep.
  function repText(rep) {
    if (!rep.sensorConnected) return `Rep ${rep.number}: no sensor data (guard not connected).`
    if (!rep.sensorSeen) return `Rep ${rep.number}: the sensor barely moved (${rep.peakGyro} °/s). Is it on the dumbbell?`
    return `Rep ${rep.number}: peak ${rep.peakGyro} °/s, ${rep.peakAccel} g${rep.fast ? ', too fast' : ''}.`
  }

  // Camera/sensor cross-check line and the per-rep list.
  function renderFusion() {
    const check = fusion.check(performance.now())
    checkEl.textContent = `Camera and sensor: ${check.message}`
    checkEl.dataset.state = check.state === 'agree' ? 'ok' : check.state.endsWith('-still') ? 'warning' : ''

    const reps = fusion.reps.slice(-5).reverse()  // newest first
    const key = JSON.stringify(reps)
    if (key === shownReps) return
    shownReps = key
    repsEl.replaceChildren(...reps.map(rep => {
      const item = root.ownerDocument.createElement('li')
      item.textContent = repText(rep)
      if (rep.fast || (rep.sensorConnected && !rep.sensorSeen)) item.dataset.state = 'warning'
      return item
    }))
    repsEl.hidden = reps.length === 0
  }

  // Shows or hides the fault banner and repeats the chime while it is showing.
  function watchHealth() {
    health.tick()
    const showing = health.alerting
    faultEl.hidden = !showing
    if (!showing) {
      lastFaultSoundAt = 0
      return
    }
    faultDetail.textContent = health.problem.message
    faultReconnect.hidden = guard.state === 'connected' || guard.connecting
    const time = Date.now()
    if (time - lastFaultSoundAt >= FAULT_SOUND_EVERY_MS) {
      lastFaultSoundAt = time
      sound.play()
    }
  }
  setInterval(() => { watchHealth(); renderFusion() }, 250)

  faultDismiss.addEventListener('click', () => {
    health.dismiss()
    watchHealth()
  })
  faultReconnect.addEventListener('click', () => toggleConnection())

  connectButton.addEventListener('click', () => toggleConnection())

  async function toggleConnection() {
    sound.unlock()  // a click is the only moment the browser lets us enable sound
    if (guard.state === 'connected') {
      health.userDisconnecting()  // so this disconnect is not reported as a fault
      return link.disconnect()
    }
    if (guard.connecting) return
    guard.connecting = true
    guard.error = null
    render()
    try { await link.connect() }
    catch (error) { guard.error = error.message }
    finally {
      guard.connecting = false
      render()
    }
  }

  render()
  repsEl.hidden = true
  return {
    link,
    // Called by the page for every camera frame: now = performance.now() (ms), and
    // lanes = [{ angle, reps }], the rep angle in degrees (null if no arm is seen) and
    // the rep count of each tracked limb.
    camera(now, lanes) { fusion.camera(now, lanes) },
  }
}