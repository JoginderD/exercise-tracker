import test from 'node:test'
import assert from 'node:assert/strict'
import { createAlarmSound } from '../src/alarm-sound.js'

// Minimal fake of the parts of the Web Audio API that alarm-sound.js uses.
function fakeAudio() {
  const log = { contexts: 0, oscillators: [], resumed: 0 }
  class FakeAudioContext {
    constructor() { log.contexts++; this.state = 'suspended'; this.currentTime = 10; this.destination = {} }
    resume() { log.resumed++; this.state = 'running' }
    createOscillator() {
      const osc = { frequency: {}, connect() {}, start(t) { osc.startAt = t }, stop() {} }
      log.oscillators.push(osc)
      return osc
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }
    }
  }
  return { FakeAudioContext, log }
}

test('play does nothing until unlock() has been called', () => {
  const { FakeAudioContext, log } = fakeAudio()
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext })
  assert.equal(sound.play(), false)
  assert.equal(log.oscillators.length, 0)
})

test('unlock creates one audio context and resumes it', () => {
  const { FakeAudioContext, log } = fakeAudio()
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext })
  assert.equal(sound.unlock(), true)
  sound.unlock()
  assert.equal(log.contexts, 1)
  assert.equal(log.resumed, 1)
})

test('play schedules three soft sine notes (high, low, high), one after another', () => {
  const { FakeAudioContext, log } = fakeAudio()
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext })
  sound.unlock()
  assert.equal(sound.play(), true)
  assert.equal(log.oscillators.length, 3)
  assert.deepEqual(log.oscillators.map(o => o.frequency.value), [698, 523, 698])
  assert.ok(log.oscillators.every(o => o.type === 'sine'))
  const starts = log.oscillators.map(o => o.startAt)
  assert.ok(starts[0] < starts[1] && starts[1] < starts[2])
})

test('a repeat alarm inside 1.5 s is ignored, a later one plays', () => {
  const { FakeAudioContext, log } = fakeAudio()
  let time = 0
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext, now: () => time })
  sound.unlock()
  assert.equal(sound.play(), true)
  time = 1000
  assert.equal(sound.play(), false)
  time = 1600
  assert.equal(sound.play(), true)
  assert.equal(log.oscillators.length, 6)
})

test('muted sound is silent, and unmuting restores it', () => {
  const { FakeAudioContext, log } = fakeAudio()
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext })
  sound.unlock()
  sound.muted = true
  assert.equal(sound.play(), false)
  assert.equal(log.oscillators.length, 0)
  sound.muted = false
  assert.equal(sound.play(), true)
})

test('without Web Audio support it reports unavailable and never throws', () => {
  const sound = createAlarmSound({ AudioContextClass: undefined })
  assert.equal(sound.available, false)
  assert.equal(sound.unlock(), false)
  assert.equal(sound.play(), false)
})