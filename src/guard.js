// Bluetooth LE link to the Curl Guard device (guard-firmware/ in this repo).
// The packet layout mirrors SensorPacket in guard-firmware/src/main.cpp; change both together.
import { bluetoothUnavailable } from './imu.js'

export const GUARD_SERVICE = '7f3a0001-5b6c-4d2e-9a10-3c4d5e6f7a80'
const GUARD_DATA = '7f3a0002-5b6c-4d2e-9a10-3c4d5e6f7a80'
const GUARD_NAME = 'ExerciseTracker1'
const PACKET_BYTES = 18
const NO_BATTERY = 255  // the firmware sends 255 when it cannot see a battery

// Bits of the `alarms` byte. A bit is set in the one packet that follows the event.
export const ALARM = { fast: 1 << 0, drop: 1 << 1 }

// Decodes one notification (an 18-byte DataView, little-endian) into:
//   t        device time in ms
//   ax..az   acceleration in g
//   gx..gz   angular velocity in deg/s
//   alarms   raw alarm bits, plus the booleans fast and drop
//   battery  percent 0-100, or null when no battery is detected
// Byte layout: t 0-3 | ax ay az 4-9 | gx gy gz 10-15 | alarms 16 | battery 17.
export function parsePacket(view) {
  if (view.byteLength < PACKET_BYTES) {
    throw new Error(`Packet too short (${view.byteLength} bytes, expected ${PACKET_BYTES}).`)
  }
  const alarms = view.getUint8(16)
  const battery = view.getUint8(17)
  return {
    t: view.getUint32(0, true),
    // The firmware sends milli-g and tenths of deg/s as integers; convert back here.
    ax: view.getInt16(4, true) / 1000,
    ay: view.getInt16(6, true) / 1000,
    az: view.getInt16(8, true) / 1000,
    gx: view.getInt16(10, true) / 10,
    gy: view.getInt16(12, true) / 10,
    gz: view.getInt16(14, true) / 10,
    alarms,
    fast: Boolean(alarms & ALARM.fast),
    drop: Boolean(alarms & ALARM.drop),
    battery: battery === NO_BATTERY ? null : battery,
  }
}

// onPacket(packet) runs for each notification.
// onState({ state, device, error? }) runs on 'connecting', 'connected', 'disconnected'
// and 'error' (a packet that could not be decoded).
export function createGuardLink({ onPacket, onState }) {
  let device = null
  let characteristic = null

  const state = (name, extra = {}) => onState({ state: name, device: device?.name ?? GUARD_NAME, ...extra })

  function handle(event) {
    let packet
    try {
      packet = parsePacket(event.target.value)
    } catch (error) {
      state('error', { error })  // one bad packet is reported, but the link stays open
      return
    }
    onPacket(packet)
  }

  function onDisconnected() {
    characteristic?.removeEventListener('characteristicvaluechanged', handle)
    characteristic = null
    state('disconnected')
  }

  return {
    get connected() { return Boolean(device?.gatt.connected && characteristic) },

    // Must run from a click: the browser shows its device chooser.
    // Resolves to true when connected and false when the chooser was closed without a choice.
    async connect() {
      const unavailable = bluetoothUnavailable()
      if (unavailable) throw new Error(unavailable)

      let chosen
      try {
        chosen = await navigator.bluetooth.requestDevice({
          filters: [{ name: GUARD_NAME }],
          optionalServices: [GUARD_SERVICE],  // the page may only use services it declares here
        })
      } catch (error) {
        if (error.name === 'NotFoundError') return false  // chooser closed without picking
        throw error
      }

      // The same function is registered again for the same device, so no duplicate listener.
      if (device && device !== chosen) device.removeEventListener('gattserverdisconnected', onDisconnected)
      device = chosen
      device.addEventListener('gattserverdisconnected', onDisconnected)

      state('connecting')
      try {
        const server = await device.gatt.connect()
        const service = await server.getPrimaryService(GUARD_SERVICE)
        characteristic = await service.getCharacteristic(GUARD_DATA)
        characteristic.addEventListener('characteristicvaluechanged', handle)
        await characteristic.startNotifications()
      } catch (error) {
        if (device.gatt.connected) device.gatt.disconnect()  // also fires 'disconnected'
        else state('disconnected')
        throw new Error(`Could not connect to ${device.name ?? 'the guard'}: ${error.message}`)
      }
      state('connected')
      return true
    },

    disconnect() {
      // gatt.disconnect() fires 'gattserverdisconnected', which reports the new state.
      if (device?.gatt.connected) device.gatt.disconnect()
      else state('disconnected')
    },
  }
}