import test from 'node:test'
import assert from 'node:assert/strict'
import { createAlarmSound } from '../src/alarm-sound.js'

// Minimal fake of the parts of the Web Audio API that alarm-sound.js uses.
function fakeAudio() {
  const log = { contexts: 0, oscillators: [], resumed: 0, bufferPlays: 0 }
  class FakeAudioContext {
    constructor() { log.contexts++; this.state = 'suspended'; this.currentTime = 10; this.destination = {} }
    resume() { log.resumed++; this.state = 'running' }
    createOscillator() {
      const osc = {
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {}, start(t) { osc.startAt = t }, stop() {},
      }
      log.oscillators.push(osc)
      return osc
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }
    }
    createBufferSource() {
      return { connect() {}, start() { log.bufferPlays++ } }
    }
    decodeAudioData(data) { return Promise.resolve({ decoded: data }) }
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

// ---- drop sound ----
const noFiles = () => Promise.resolve({ ok: false })
const wait = () => new Promise(resolve => setTimeout(resolve, 0))

test('playDrop does nothing until unlock() has been called', () => {
  const { FakeAudioContext } = fakeAudio()
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext, fetchFile: noFiles })
  assert.equal(sound.playDrop(), false)
})

test('without a sound file the drop sound is a falling whistle', async () => {
  const { FakeAudioContext, log } = fakeAudio()
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext, fetchFile: noFiles, baseUrl: '/' })
  sound.unlock()
  await wait()
  assert.equal(sound.usingFile, false)
  assert.equal(sound.playDrop(), true)
  assert.equal(log.oscillators.length, 1)
  assert.equal(log.bufferPlays, 0)
})

test('with a sound file the file is played instead of the whistle', async () => {
  const { FakeAudioContext, log } = fakeAudio()
  const asked = []
  const fetchFile = url => {
    asked.push(url)
    return Promise.resolve(url.endsWith('wilhelm.mp3')
      ? { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }
      : { ok: false })
  }
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext, fetchFile, baseUrl: '/app/' })
  sound.unlock()
  await wait(); await wait()
  assert.deepEqual(asked, ['/app/sounds/wilhelm.mp3'])
  assert.equal(sound.usingFile, true)
  assert.equal(sound.playDrop(), true)
  assert.equal(log.bufferPlays, 1)
  assert.equal(log.oscillators.length, 0)
})

test('a page returned instead of audio (decode fails) falls back to the whistle', async () => {
  const { FakeAudioContext, log } = fakeAudio()
  FakeAudioContext.prototype.decodeAudioData = () => Promise.reject(new Error('not audio'))
  const fetchFile = () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext, fetchFile })
  sound.unlock()
  for (let i = 0; i < 6; i++) await wait()
  assert.equal(sound.usingFile, false)
  assert.equal(sound.playDrop(), true)
  assert.equal(log.oscillators.length, 1)
})

test('drop sound repeats are spaced 3 s apart and obey mute', () => {
  const { FakeAudioContext } = fakeAudio()
  let time = 0
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext, fetchFile: noFiles, now: () => time })
  sound.unlock()
  assert.equal(sound.playDrop(), true)
  time = 2000
  assert.equal(sound.playDrop(), false)
  time = 3100
  sound.muted = true
  assert.equal(sound.playDrop(), false)
  sound.muted = false
  assert.equal(sound.playDrop(), true)
})

test('a file added after the first click is found on the next click', async () => {
  const { FakeAudioContext, log } = fakeAudio()
  let fileExists = false
  const fetchFile = url => Promise.resolve(fileExists && url.endsWith('wilhelm.mp3')
    ? { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }
    : { ok: false })
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext, fetchFile })
  sound.unlock()
  for (let i = 0; i < 6; i++) await wait()
  assert.equal(sound.dropSource, 'built-in whistle')
  fileExists = true
  sound.unlock()
  for (let i = 0; i < 6; i++) await wait()
  assert.equal(sound.dropSource, 'wilhelm.mp3')
  assert.equal(sound.playDrop(), true)
  assert.equal(log.bufferPlays, 1)
})

test('playDrop right after the first click waits for the file instead of playing the whistle', async () => {
  const { FakeAudioContext, log } = fakeAudio()
  const fetchFile = url => Promise.resolve(url.endsWith('wilhelm.mp3')
    ? { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }
    : { ok: false })
  const sound = createAlarmSound({ AudioContextClass: FakeAudioContext, fetchFile })
  sound.unlock()
  assert.equal(sound.playDrop(), true)  // the file has not finished loading yet
  for (let i = 0; i < 8; i++) await wait()
  assert.equal(log.bufferPlays, 1)
  assert.equal(log.oscillators.length, 0)
})