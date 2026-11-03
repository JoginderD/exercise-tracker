// Bluetooth LE link to the dumbbell sensor (firmware/ in this repo). The packet layout
// mirrors firmware/src/protocol.h; change both together.

export const IMU_SERVICE = '6e0a0001-7c3b-4d9a-9f3e-2b1d5a8c4f10'
const DATA = '6e0a0002-7c3b-4d9a-9f3e-2b1d5a8c4f10'
const CONTROL = '6e0a0003-7c3b-4d9a-9f3e-2b1d5a8c4f10'
const INFO = '6e0a0004-7c3b-4d9a-9f3e-2b1d5a8c4f10'
const PROTOCOL_VERSION = 1
const HEADER_BYTES = 16
const SAMPLE_BYTES = 20
const G = 9.80665

export const FLAGS = { still:1, calibrating:2, gyroReady:4, accelCalibrated:8, sensorError:16, saturated:32, linkTooSmall:64 }
export const COMMANDS = { calibrateGyro:1, calibrateAccel:2, cancel:3, forget:4 }
const ACCEL_STATES = ['idle', 'collecting', 'done', 'failed']

export class ProtocolError extends Error {}

// Decodes one notification into header fields and samples in SI-ish units:
// accel m/s² (world frame, gravity removed), gyro °/s (sensor frame), t in device ms.
export function parsePacket(view) {
  if (view.byteLength < HEADER_BYTES) throw new ProtocolError(`Packet too short (${view.byteLength} bytes).`)
  const version = view.getUint8(0)
  if (version !== PROTOCOL_VERSION) throw new ProtocolError(`Sensor firmware speaks protocol ${version}; this page expects ${PROTOCOL_VERSION}. Reflash the sensor.`)
  const flags = view.getUint8(1)
  const count = view.getUint8(2)
  const periodMs = view.getUint8(3)
  const firstIndex = view.getUint32(4, true)
  const firstMs = view.getUint32(8, true)
  const progress = view.getUint8(14)
  if (view.byteLength < HEADER_BYTES + count * SAMPLE_BYTES) throw new ProtocolError('Packet shorter than its sample count.')
  const samples = []
  for (let i = 0; i < count; i++) {
    const base = HEADER_BYTES + i * SAMPLE_BYTES
    const int = offset => view.getInt16(base + offset, true)
    samples.push({
      index:(firstIndex + i) >>> 0,
      t:firstMs + i * periodMs,
      q:[int(0), int(2), int(4), int(6)].map(value => value / 32767),
      accel:[int(8), int(10), int(12)].map(value => value / 1000 * G),
      gyro:[int(14), int(16), int(18)].map(value => value / 10),
      still:Boolean(flags & FLAGS.still),
    })
  }
  return {
    flags, count, periodMs, firstIndex, firstMs, samples,
    tempC:view.getInt16(12, true) / 100,
    accelPoses:progress & 0x0f,
    accelState:ACCEL_STATES[progress >> 4] ?? 'idle',
    gyroCalCount:view.getUint8(15),
    has:name => Boolean(flags & FLAGS[name]),
  }
}

// Why this browser cannot connect, or null if it can.
export function bluetoothUnavailable() {
  if (typeof navigator === 'undefined' || !navigator.bluetooth) {
    return 'This browser has no Web Bluetooth. Use Chrome or Edge on a computer or Android phone (not iPhone Safari or Firefox).'
  }
  if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
    return 'Bluetooth only works on https:// or http://localhost. Open the site that way to connect the sensor.'
  }
  return null
}

// onPacket(packet) for each notification; onState({ state, device, info, error }) on
// connect, disconnect and failures. A dropped link is retried a few times by itself.
export function createImuLink({ onPacket, onState }) {
  let device = null
  let control = null
  let infoChar = null
  let info = null
  let wanted = false
  let retries = 0

  const decoder = new TextDecoder()
  const state = (name, extra = {}) => onState({ state:name, device:device?.name ?? 'sensor', info, ...extra })

  function handle(event) {
    try { onPacket(parsePacket(event.target.value)) }
    catch (error) {
      if (error instanceof ProtocolError) { state('error', { error }); disconnect() }
      else throw error
    }
  }

  async function readInfo() {
    if (!infoChar) return info
    try { info = JSON.parse(decoder.decode(await infoChar.readValue())) }
    catch { /* informational only; a failed read leaves the last value */ }
    return info
  }

  async function open() {
    state('connecting')
    const server = await device.gatt.connect()
    const service = await server.getPrimaryService(IMU_SERVICE)
    const [data, controlChar, infoCharacteristic] = await Promise.all([DATA, CONTROL, INFO].map(id => service.getCharacteristic(id)))
    control = controlChar
    infoChar = infoCharacteristic
    await readInfo()
    data.addEventListener('characteristicvaluechanged', handle)
    await data.startNotifications()
    retries = 0
    state('connected')
  }

  async function onDisconnected() {
    control = null
    infoChar = null
    if (!wanted) return state('disconnected')
    if (retries >= 3) { wanted = false; return state('disconnected', { error:new Error('Lost the sensor. Check it is switched on and within a few metres, then connect again.') }) }
    retries++
    state('reconnecting', { attempt:retries })
    await new Promise(done => setTimeout(done, 1000 * retries))
    if (!wanted) return
    try { await open() }
    catch { onDisconnected() }
  }

  async function disconnect() {
    wanted = false
    if (device?.gatt.connected) device.gatt.disconnect()
    else state('disconnected')
  }

  return {
    get connected() { return Boolean(device?.gatt.connected && control) },
    // Must run from a click: the browser shows its device chooser.
    async connect() {
      const unavailable = bluetoothUnavailable()
      if (unavailable) throw new Error(unavailable)
      let chosen
      try {
        chosen = await navigator.bluetooth.requestDevice({ filters:[{ services:[IMU_SERVICE] }] })
      } catch (error) {
        if (error.name === 'NotFoundError') return false  // chooser closed without picking
        throw error
      }
      if (device && device !== chosen) device.removeEventListener('gattserverdisconnected', onDisconnected)
      device = chosen
      device.addEventListener('gattserverdisconnected', onDisconnected)
      wanted = true
      retries = 0
      try {
        await open()
      } catch (error) {
        wanted = false
        if (device.gatt.connected) device.gatt.disconnect()
        throw new Error(`Could not connect to ${device.name ?? 'the sensor'}: ${error.message}`)
      }
      return true
    },
    disconnect,
    readInfo,
    async send(command) {
      if (!control) throw new Error('The sensor is not connected.')
      await control.writeValueWithResponse(Uint8Array.of(command))
    },
  }
}
