import test from 'node:test'
import assert from 'node:assert/strict'

// A stand-in for the browser's recogniser, driven by the test.
const made = []
globalThis.navigator ??= { language:'en-GB' }
globalThis.webkitSpeechRecognition = class {
  constructor() { made.push(this) }
  start() { this.started = true }
  stop() { setTimeout(() => this.onend(), 0) }
  abort() { this.aborted = true }
  say(results, resultIndex = 0) {
    this.onresult({ resultIndex, results:results.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) })
  }
}
const { startTranscript } = await import('../src/transcriber.js')

test('joins final words across pauses and keeps the last unfinished words on stop', async () => {
  made.length = 0
  const seen = []
  const transcript = startTranscript({ onText:text => seen.push(text) })
  made[0].say([['Is my knee', true], [' too far', false]])
  assert.equal(seen.at(-1), 'Is my knee too far')
  // The browser ends recognition after a pause; a new one carries on.
  made[0].onend()
  assert.equal(made.length, 2)
  assert.equal(made[1].lang, navigator.language)
  made[1].say([['forward?', false]])
  assert.equal(await transcript.stop(), 'Is my knee forward?')
})

test('gives up on a blocked service and on a recogniser that keeps ending at once', async () => {
  made.length = 0
  const problems = []
  const blocked = startTranscript({ onUnavailable:code => problems.push(code) })
  made[0].onerror({ error:'not-allowed' })
  made[0].onerror({ error:'no-speech' })
  assert.deepEqual(problems, ['not-allowed'])
  assert.equal(await blocked.stop(), '')

  made.length = 0
  const looping = startTranscript({ onUnavailable:code => problems.push(code) })
  for (let i = 0; i < 6; i++) made.at(-1).onend()
  assert.equal(problems.at(-1), 'stopped')
  assert.equal(made.length, 6)
  looping.cancel()
})
