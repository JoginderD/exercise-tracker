import test from 'node:test'
import assert from 'node:assert/strict'
import { createGuardHealth, isPlausible } from '../src/guard-health.js'

const good = { ax: 0.1, ay: -0.2, az: 0.98, gx: 12, gy: -5, gz: 0 }
const bad = { ...good, ax: 20 }  // 20 g is impossible for a +-8 g sensor

function setup() {
  let time = 0
  const health = createGuardHealth({ now: () => time })
  return { health, advance: ms => { time += ms } }
}

test('isPlausible accepts normal readings and rejects impossible ones', () => {
  assert.equal(isPlausible(good), true)
  assert.equal(isPlausible({ ...good, ax: 8 }), true)         // right at the sensor limit
  assert.equal(isPlausible({ ...good, az: -20 }), false)
  assert.equal(isPlausible({ ...good, gy: 1500 }), false)
  assert.equal(isPlausible({ ...good, gx: NaN }), false)
})

test('a healthy link has no problem', () => {
  const { health, advance } = setup()
  health.linkUp()
  for (let i = 0; i < 50; i++) { advance(40); health.packet(good); health.tick() }
  assert.equal(health.problem, null)
  assert.equal(health.alerting, false)
})

test('unexpected disconnect raises "lost" and keeps alerting', () => {
  const { health } = setup()
  health.linkUp()
  health.linkDown()
  assert.equal(health.problem.code, 'lost')
  assert.equal(health.alerting, true)
})

test('pressing Disconnect is not a problem', () => {
  const { health } = setup()
  health.linkUp()
  health.userDisconnecting()
  health.linkDown()
  assert.equal(health.problem, null)
})

test('a failed connection attempt is not a problem', () => {
  const { health } = setup()
  health.linkDown()  // never connected
  assert.equal(health.problem, null)
})

test('reconnecting clears the lost warning', () => {
  const { health } = setup()
  health.linkUp()
  health.linkDown()
  health.linkUp()
  assert.equal(health.problem, null)
})

test('one or two bad packets are tolerated, three in a row are a problem', () => {
  const { health } = setup()
  health.linkUp()
  health.packet(bad); health.packet(bad)
  assert.equal(health.problem, null)
  health.packet(good)  // a good packet resets the count
  health.packet(bad); health.packet(bad)
  assert.equal(health.problem, null)
  health.packet(bad)
  assert.equal(health.problem.code, 'bad-data')
})

test('undecodable packets count as bad too', () => {
  const { health } = setup()
  health.linkUp()
  health.badPacket(); health.badPacket(); health.badPacket()
  assert.equal(health.problem.code, 'bad-data')
})

test('bad-data clears by itself once good packets return', () => {
  const { health } = setup()
  health.linkUp()
  for (let i = 0; i < 3; i++) health.packet(bad)
  health.packet(good)
  assert.equal(health.problem, null)
})

test('silence for more than 1.5 s raises "stalled", and good data clears it', () => {
  const { health, advance } = setup()
  health.linkUp()
  advance(1400); health.tick()
  assert.equal(health.problem, null)
  advance(200); health.tick()
  assert.equal(health.problem.code, 'stalled')
  health.packet(good)
  assert.equal(health.problem, null)
})

test('dismiss silences the problem until it changes or recovers', () => {
  const { health } = setup()
  health.linkUp()
  health.linkDown()
  health.dismiss()
  assert.equal(health.alerting, false)
  assert.equal(health.problem.code, 'lost')  // still a problem, just silenced
  health.linkUp()
  health.linkDown()  // a new loss alerts again
  assert.equal(health.alerting, true)
})

test('packets before the link is up are ignored', () => {
  const { health } = setup()
  health.packet(bad); health.packet(bad); health.packet(bad)
  assert.equal(health.problem, null)
})