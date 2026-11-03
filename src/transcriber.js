// A live transcript of a video question, from the browser's own speech recognition
// (Chrome and Edge send the audio to their speech service; Safari can work on the device;
// Firefox has none). Nothing here is required: without it the question is sent untranscribed.
const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition
// Errors after which listening again would fail the same way.
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported'])
const REASONS = {
  'not-supported':'this browser cannot transcribe speech',
  'not-allowed':'speech recognition is blocked in this browser',
  'service-not-allowed':'speech recognition is blocked in this browser',
  'audio-capture':'the microphone could not be used for the transcript',
  network:'the speech service could not be reached',
  'language-not-supported':'your language is not supported for transcripts',
  stopped:'speech recognition kept stopping',
}
export const transcriptReason = code => REASONS[code] ?? 'speech recognition stopped'

// onText(text) runs as words arrive (the last words may still change); onUnavailable(code)
// when there will be no more. Returns null when the browser has no speech recognition.
export function startTranscript({ onText = () => {}, onUnavailable = () => {} }) {
  if (typeof Recognition !== 'function') { onUnavailable('not-supported'); return null }
  const finals = []
  let interim = ''
  let active = true
  let finish = null
  let recognition
  // Recognisers end after a pause or about a minute; each end starts a new one while
  // recording, unless they keep ending at once (a loop that would never hear anything).
  let restarts = []
  const text = () => [...finals, interim.trim()].filter(Boolean).join(' ')

  function listen() {
    recognition = new Recognition()
    recognition.lang = navigator.language || 'en-US'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = event => {
      interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) finals.push(result[0].transcript.trim())
        else interim += result[0].transcript
      }
      onText(text())
    }
    recognition.onerror = event => {
      if (!FATAL.has(event.error)) return
      active = false
      onUnavailable(event.error)
    }
    recognition.onend = () => {
      if (!active) { finish?.(); return }
      const now = Date.now()
      restarts = [...restarts.filter(at => now - at < 5000), now]
      if (restarts.length > 5) { active = false; onUnavailable('stopped'); return }
      try { listen() } catch { active = false; onUnavailable('stopped') }
    }
    recognition.start()
  }
  try { listen() } catch { onUnavailable('stopped'); return null }

  return {
    // Resolves with the whole transcript once the last words are in (at most 1.5 s).
    stop() {
      return new Promise(resolve => {
        const timeout = setTimeout(() => finish(), 1500)
        finish = () => { clearTimeout(timeout); finish = null; resolve(text()) }
        if (!active) return finish()
        active = false
        try { recognition.stop() } catch { finish() }
      })
    },
    cancel() {
      active = false
      finish = null
      try { recognition.abort() } catch {}
    },
  }
}
