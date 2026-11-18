// Curl Guard panel: connect button, alarm banner, battery and a live readout.
// Self-contained, so main.js only needs a placeholder <section> and one call.
import './guard-panel.css'
import { createGuardLink } from './guard.js'
import { bluetoothUnavailable } from './imu.js'

const ALARM_HOLD_MS = 2000  // the firmware flags an alarm in one packet only, so keep it on screen

// root: the <section> to fill. onPacket(packet): optional hook, e.g. for a live graph.
export function createGuardPanel(root, { onPacket } = {}) {
  root.innerHTML = `
    <h2 id="guard-title">Curl guard</h2>
    <p class="hint guard-status" role="status"></p>
    <div class="button-row"><button type="button" class="guard-connect">Connect guard</button></div>
    <p class="guard-alarm" aria-live="polite"></p>
    <dl class="guard-readout">
      <div><dt>Battery</dt><dd class="guard-battery">–</dd></div>
      <div><dt>Packets</dt><dd class="guard-rate">–</dd></div>
      <div><dt>Acceleration</dt><dd class="guard-accel">–</dd></div>
      <div><dt>Rotation</dt><dd class="guard-gyro">–</dd></div>
    </dl>
    <p class="hint">A small sensor on the dumbbell. It lights an LED and beeps by itself when a curl is too fast
    or the dumbbell is dropped, and reports its battery level.</p>`

  const $ = selector => root.querySelector(selector)
  const statusEl = $('.guard-status')
  const connectButton = $('.guard-connect')
  const alarmEl = $('.guard-alarm')
  const batteryEl = $('.guard-battery')
  const rateEl = $('.guard-rate')
  const accelEl = $('.guard-accel')
  const gyroEl = $('.guard-gyro')

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
        return
      }
      guard.state = event.state
      guard.name = event.device
      if (event.state === 'connected') {
        guard.error = null
        guard.count = guard.rate = 0
        startTimers()
      } else if (event.state === 'disconnected') {
        stopTimers()
        guard.packet = null
        guard.alarm = null
      }
      render()
    },
    onPacket(packet) {
      guard.packet = packet
      guard.count++
      if (packet.fast || packet.drop) {
        guard.alarm = [packet.fast && 'Too fast', packet.drop && 'Drop detected'].filter(Boolean).join(' + ')
        guard.alarmAt = Date.now()
      }
      onPacket?.(packet)
    },
  })

  connectButton.addEventListener('click', async () => {
    if (guard.state === 'connected') return link.disconnect()
    guard.connecting = true
    guard.error = null
    render()
    try { await link.connect() }
    catch (error) { guard.error = error.message }
    finally {
      guard.connecting = false
      render()
    }
  })

  render()
  return { link }
}