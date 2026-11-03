import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePacket, ProtocolError } from '../src/imu.js'

// Encodes a packet the way firmware/src/protocol.h lays it out.
function packet({ version = 1, flags = 0, samples = [], firstIndex = 0, firstMs = 0, tempCenti = 2500, progress = 0, calCount = 0 } = {}) {
  const view = new DataView(new ArrayBuffer(16 + samples.length * 20))
  view.setUint8(0, version); view.setUint8(1, flags); view.setUint8(2, samples.length); view.setUint8(3, 10)
  view.setUint32(4, firstIndex, true); view.setUint32(8, firstMs, true); view.setInt16(12, tempCenti, true)
  view.setUint8(14, progress); view.setUint8(15, calCount)
  samples.forEach((sample, i) => sample.forEach((value, k) => view.setInt16(16 + i * 20 + k * 2, value, true)))
  return view
}

test('decodes samples into world acceleration in m/s² and gyro in °/s', () => {
  const parsed = parsePacket(packet({
    flags:1 | 4, firstIndex:4294967295, firstMs:5000, tempCenti:3125, progress:(1 << 4) | 3, calCount:2,
    samples:[[32767, 0, 0, 0, 1000, -500, 0, 100, -2000, 5], [0, 32767, 0, 0, 0, 0, -1000, 0, 0, 0]],
  }))
  assert.equal(parsed.tempC, 31.25)
  assert.equal(parsed.accelPoses, 3)
  assert.equal(parsed.accelState, 'collecting')
  assert.equal(parsed.gyroCalCount, 2)
  assert.ok(parsed.has('still') && parsed.has('gyroReady') && !parsed.has('calibrating'))
  const [first, second] = parsed.samples
  assert.deepEqual(first.q, [1, 0, 0, 0])
  assert.ok(Math.abs(first.accel[0] - 9.80665) < 1e-9 && Math.abs(first.accel[1] + 4.903325) < 1e-9)
  assert.deepEqual(first.gyro, [10, -200, 0.5])
  assert.equal(first.still, true)
  // The stream index wraps like the firmware's uint32 counter.
  assert.equal(first.index, 4294967295)
  assert.equal(second.index, 0)
  assert.equal(second.t, 5010)
  assert.ok(Math.abs(second.accel[2] + 9.80665) < 1e-9)
})

test('rejects other protocol versions and truncated packets', () => {
  assert.throws(() => parsePacket(packet({ version:2 })), ProtocolError)
  assert.throws(() => parsePacket(new DataView(new ArrayBuffer(10))), ProtocolError)
  const short = packet({ samples:[[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]] })
  assert.throws(() => parsePacket(new DataView(short.buffer, 0, 30)), ProtocolError)
})

test('a link-too-small notice carries no samples', () => {
  const parsed = parsePacket(packet({ flags:64 }))
  assert.equal(parsed.samples.length, 0)
  assert.ok(parsed.has('linkTooSmall'))
})
