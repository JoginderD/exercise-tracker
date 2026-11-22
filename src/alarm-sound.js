// Warning beeps for the Curl guard, generated with the Web Audio API (no audio file needed).
//
// Browsers only allow sound after the user has interacted with the page, so call unlock()
// from a click handler (the Connect button does this). After that play() works any time.

// A soft three-note chime: high, low, high (F5, C5, F5). Change NOTES to change the melody.
const NOTES = [698, 523, 698]  // pitch of each note in Hz
const NOTE_SECONDS = 0.28      // length of one note
const GAP_SECONDS = 0.07       // silence between notes
const ATTACK_SECONDS = 0.03    // fade-in time, makes the start gentle
const VOLUME = 0.22            // 0..1, lower is quieter
const MIN_REPEAT_MS = 1500   // ignore a new alarm that arrives before the last sound has finished

// AudioContextClass and now are injectable so the tests can run without a browser.
export function createAlarmSound({
  AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  now = () => Date.now(),
} = {}) {
  let context = null
  let muted = false
  let lastPlayedAt = -Infinity

  // Create (or wake up) the audio engine. Must run inside a user gesture such as a click.
  function unlock() {
    if (!AudioContextClass) return false
    if (!context) context = new AudioContextClass()
    if (context.state === 'suspended') context.resume()
    return true
  }

  // Schedule one soft note at an absolute audio-clock time. A sine wave sounds smooth,
  // and the volume fades in quickly and then dies away slowly, like a bell.
  function beep(startAt, hz) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = hz
    const endAt = startAt + NOTE_SECONDS
    gain.gain.setValueAtTime(0, startAt)
    gain.gain.linearRampToValueAtTime(VOLUME, startAt + ATTACK_SECONDS)
    gain.gain.linearRampToValueAtTime(0, endAt)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(startAt)
    oscillator.stop(endAt)
  }

  // Play the alarm. Returns true if it started, false if it was skipped
  // (muted, not unlocked yet, or the previous alarm is still sounding).
  function play() {
    if (muted || !context) return false
    const time = now()
    if (time - lastPlayedAt < MIN_REPEAT_MS) return false
    lastPlayedAt = time
    const start = context.currentTime + 0.02
    NOTES.forEach((hz, i) => beep(start + i * (NOTE_SECONDS + GAP_SECONDS), hz))
    return true
  }

  return {
    unlock,
    play,
    get muted() { return muted },
    set muted(value) { muted = Boolean(value) },
    get available() { return Boolean(AudioContextClass) },
  }
}