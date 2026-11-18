import test from 'node:test'
import assert from 'node:assert/strict'
import { ALARM, createGuardLink, parsePacket } from '../src/guard.js'

// Builds an 18-byte packet the way the firmware lays it out (little-endian).
function packet({ t = 0, a = [0, 0, 0], g = [0, 0, 0], alarms = 0, battery = 0 } = {}) {
  const view = new DataView(new ArrayBuffer(18))
  view.setUint32(0, t, true)
  a.forEach((v, i) => view.setInt16(4 + i * 2, v, true))
  g.forEach((v, i) => view.setInt16(10 + i * 2, v, true))
  view.setUint8(16, alarms)
  view.setUint8(17, battery)
  return view
}

test('parsePacket reads every field and converts units', () => {
  const p = parsePacket(packet({ t: 5000, a: [981, -20, 3], g: [1234, -500, 0], alarms: 3, battery: 87 }))
  assert.equal(p.t, 5000)
  assert.equal(p.ax, 0.981)
  assert.equal(p.ay, -0.02)
  assert.equal(p.az, 0.003)
  assert.equal(p.gx, 123.4)
  assert.equal(p.gy, -50)
  assert.equal(p.gz, 0)
  assert.equal(p.battery, 87)
})

test('parsePacket is little-endian: bytes E8 03 are 1000', () => {
  const view = packet()
  view.setUint8(4, 0xe8)
  view.setUint8(5, 0x03)
  assert.equal(parsePacket(view).ax, 1)
})

test('parsePacket keeps the full int16 range', () => {
  const p = parsePacket(packet({ a: [-32768, 32767, 0] }))
  assert.equal(p.ax, -32.768)
  assert.equal(p.ay, 32.767)
})

test('alarm bits map to fast and drop', () => {
  const flags = alarms => { const p = parsePacket(packet({ alarms })); return [p.fast, p.drop] }
  assert.deepEqual(flags(0), [false, false])
  assert.deepEqual(flags(ALARM.fast), [true, false])
  assert.deepEqual(flags(ALARM.drop), [false, true])
  assert.deepEqual(flags(ALARM.fast | ALARM.drop), [true, true])
})

test('battery 255 means no battery detected', () => {
  assert.equal(parsePacket(packet({ battery: 255 })).battery, null)
  assert.equal(parsePacket(packet({ battery: 0 })).battery, 0)
  assert.equal(parsePacket(packet({ battery: 100 })).battery, 100)
})

test('a packet shorter than 18 bytes is rejected', () => {
  assert.throws(() => parsePacket(new DataView(new ArrayBuffer(17))), /too short/)
})

// A fake Web Bluetooth stack, enough to walk through connect / notify / disconnect.
function fakeBluetooth() {
  const characteristic = Object.assign(new EventTarget(), { startNotifications: async () => {} })
  const service = { getCharacteristic: async () => characteristic }
  const server = { getPrimaryService: async () => service }
  const device = Object.assign(new EventTarget(), { name: 'ExerciseTracker1' })
  device.gatt = {
    connected: false,
    connect: async () => { device.gatt.connected = true; return server },
    disconnect: () => { device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')) },
  }
  const requests = []
  return {
    device, characteristic, requests,
    bluetooth: { requestDevice: async options => { requests.push(options); return device } },
    send(view) { characteristic.value = view; characteristic.dispatchEvent(new Event('characteristicvaluechanged')) },
  }
}

function withFakeBluetooth(fake, body) {
  return async () => {
    Object.defineProperty(globalThis.navigator, 'bluetooth', { value: fake.bluetooth, configurable: true })
    try { await body() } finally { delete globalThis.navigator.bluetooth }
  }
}

test('connect, receive packets, then disconnect', async () => {
  const fake = fakeBluetooth()
  await withFakeBluetooth(fake, async () => {
    const states = [], packets = []
    const link = createGuardLink({ onPacket: p => packets.push(p), onState: s => states.push(s.state) })

    assert.equal(await link.connect(), true)
    assert.deepEqual(states, ['connecting', 'connected'])
    assert.equal(link.connected, true)
    assert.equal(fake.requests[0].filters[0].name, 'ExerciseTracker1')

    fake.send(packet({ t: 40, battery: 90, alarms: ALARM.fast }))
    assert.equal(packets.length, 1)
    assert.equal(packets[0].battery, 90)
    assert.equal(packets[0].fast, true)

    link.disconnect()
    assert.deepEqual(states, ['connecting', 'connected', 'disconnected'])
    assert.equal(link.connected, false)
  })()
})

test('a bad packet is reported but the link keeps working', async () => {
  const fake = fakeBluetooth()
  await withFakeBluetooth(fake, async () => {
    const states = [], packets = []
    const link = createGuardLink({ onPacket: p => packets.push(p), onState: s => states.push(s.state) })
    await link.connect()
    fake.send(new DataView(new ArrayBuffer(5)))
    fake.send(packet({ battery: 50 }))
    assert.equal(states.at(-1), 'error')
    assert.equal(packets.length, 1)
    assert.equal(link.connected, true)
  })()
})

test('closing the chooser is not an error', async () => {
  const fake = fakeBluetooth()
  fake.bluetooth.requestDevice = async () => { throw Object.assign(new Error('none'), { name: 'NotFoundError' }) }
  await withFakeBluetooth(fake, async () => {
    const link = createGuardLink({ onPacket() {}, onState() {} })
    assert.equal(await link.connect(), false)
  })()
})

test('reconnecting does not duplicate packets', async () => {
  const fake = fakeBluetooth()
  await withFakeBluetooth(fake, async () => {
    const packets = []
    const link = createGuardLink({ onPacket: p => packets.push(p), onState() {} })
    await link.connect()
    link.disconnect()
    await link.connect()
    fake.send(packet({ battery: 10 }))
    assert.equal(packets.length, 1)
  })()
})