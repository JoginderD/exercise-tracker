// Sounds for the Curl guard, played with the Web Audio API.
//   play()      a soft three-note chime for "curl too fast" (made in code, no file needed)
//   playDrop()  the drop sound. If a sound file is in public/sounds/ (wilhelm.mp3, .ogg or .wav)
//               that file is played; if not, a falling whistle made in code is used instead.
//
// Browsers only allow sound after the user has interacted with the page, so call unlock()
// from a click handler (the Connect button does this). After that the sounds work any time.

// A soft three-note chime: high, low, high (F5, C5, F5). Change NOTES to change the melody.
const NOTES = [698, 523, 698]  // pitch of each note in Hz
const NOTE_SECONDS = 0.28      // length of one note
const GAP_SECONDS = 0.07       // silence between notes
const ATTACK_SECONDS = 0.03    // fade-in time, makes the start gentle
const VOLUME = 0.22            // 0..1, lower is quieter
const MIN_REPEAT_MS = 1500   // ignore a new alarm that arrives before the last sound has finished

// Files looked for, in this order, in the public/sounds folder.
const DROP_FILES = ['sounds/wilhelm.mp3', 'sounds/wilhelm.ogg', 'sounds/wilhelm.wav']
const MIN_DROP_REPEAT_MS = 3000  // the drop sound is longer, so repeats are spaced further apart
const FALL_START_HZ = 1000       // the fallback whistle falls from this pitch...
const FALL_END_HZ = 180          // ...to this one
const FALL_SECONDS = 1.2

// AudioContextClass, now, fetchFile and baseUrl are injectable so the tests can run without a browser.
export function createAlarmSound({
  AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  now = () => Date.now(),
  fetchFile = globalThis.fetch?.bind(globalThis),
  baseUrl = import.meta.env?.BASE_URL ?? '/',
} = {}) {
  let context = null
  let muted = false
  let lastPlayedAt = -Infinity
  let lastDropAt = -Infinity
  let dropBuffer = null    // the decoded sound file, once it has loaded
  let dropLoading = false
  let dropLoadPromise = null   // resolves when the current load attempt has finished
  let dropSource = 'not loaded yet'  // what the drop sound is right now, shown on the page

  // Looks for the drop sound file and decodes it. Any failure (no file, bad format) is fine:
  // playDrop() then uses the whistle made in code.
  function loadDropSound() {
    if (dropBuffer || dropLoading || !context || !fetchFile) return
    dropLoading = true
    dropLoadPromise = tryLoadDropSound()
  }
  async function tryLoadDropSound() {
    dropSource = 'loading'
    let problem = 'no file found in public/sounds'
    for (const file of DROP_FILES) {
      try {
        const response = await fetchFile(baseUrl + file)
        if (!response.ok) continue
        dropBuffer = await context.decodeAudioData(await response.arrayBuffer())
        dropSource = file.split('/').pop()
        console.info(`Curl guard: drop sound loaded from ${file}`)
        break
      } catch {
        // A missing file makes the dev server answer with the web page itself, which cannot be
        // decoded as audio. Try the next name.
        problem = `${file} could not be read as audio`
      }
    }
    if (!dropBuffer) {
      dropSource = 'built-in whistle'
      console.warn(`Curl guard: using the built-in whistle (${problem})`)
    }
    dropLoading = false
  }

  // Create (or wake up) the audio engine. Must run inside a user gesture such as a click.
  function unlock() {
    if (!AudioContextClass) return false
    if (!context) context = new AudioContextClass()
    if (context.state === 'suspended') context.resume()
    loadDropSound()  // in the background; tries again on every click until a file has loaded
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

  // A whistle that falls in pitch, used when there is no sound file.
  function fallingWhistle(startAt) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(FALL_START_HZ, startAt)
    oscillator.frequency.exponentialRampToValueAtTime(FALL_END_HZ, startAt + FALL_SECONDS)
    gain.gain.setValueAtTime(0, startAt)
    gain.gain.linearRampToValueAtTime(VOLUME, startAt + 0.05)
    gain.gain.linearRampToValueAtTime(0, startAt + FALL_SECONDS)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(startAt)
    oscillator.stop(startAt + FALL_SECONDS)
  }

  // Play the drop sound. Returns true if it started, false if it was skipped
  // (muted, not unlocked yet, or the previous drop sound is still playing).
  function playDrop() {
    if (muted || !context) return false
    const time = now()
    if (time - lastDropAt < MIN_DROP_REPEAT_MS) return false
    lastDropAt = time
    // If the file is still loading, wait for it (a few milliseconds) instead of playing the whistle.
    if (dropLoading && dropLoadPromise) dropLoadPromise.then(startDropSound)
    else startDropSound()
    return true
  }

  function startDropSound() {
    if (dropBuffer) {
      const source = context.createBufferSource()
      source.buffer = dropBuffer
      source.connect(context.destination)
      source.start()
    } else {
      fallingWhistle(context.currentTime + 0.02)
    }
  }

  return {
    unlock,
    play,
    playDrop,
    get usingFile() { return dropBuffer !== null },
    // 'wilhelm.mp3' (the file name) or 'built-in whistle' or 'loading' or 'not loaded yet'
    get dropSource() { return dropSource },
    get muted() { return muted },
    set muted(value) { muted = Boolean(value) },
    get available() { return Boolean(AudioContextClass) },
  }
}
