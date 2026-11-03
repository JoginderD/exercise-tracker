// Records a spoken question with the microphone. Opus at a low bitrate keeps three
// minutes under a megabyte; Safari records AAC in MP4 instead.
export const MAX_VOICE_MS = 3 * 60 * 1000
const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']

export const voiceSupported = () =>
  typeof MediaRecorder === 'function' && Boolean(navigator.mediaDevices?.getUserMedia)

// onStop({ blob, type, durationMs }) runs once, when stop() is called, the time limit is
// reached or the microphone goes away. Throws if the microphone cannot be opened.
export async function startVoice({ onStop, onTick = () => {} }) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true } })
  const mimeType = TYPES.find(type => MediaRecorder.isTypeSupported(type))
  const recorder = new MediaRecorder(stream, { ...mimeType ? { mimeType } : {}, audioBitsPerSecond:32000 })
  const chunks = []
  const startedAt = performance.now()
  let durationMs = 0
  const tick = setInterval(() => {
    const elapsed = performance.now() - startedAt
    onTick(elapsed)
    if (elapsed >= MAX_VOICE_MS) stop()
  }, 250)
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
  recorder.onstop = () => {
    clearInterval(tick)
    stream.getTracks().forEach(track => track.stop())
    // The server checks the plain type; codecs are only a hint for the browser.
    const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0]
    onStop({ blob:new Blob(chunks, { type }), type, durationMs })
  }
  stream.getAudioTracks()[0]?.addEventListener('ended', () => stop())
  function stop() {
    if (recorder.state === 'inactive') return
    durationMs = Math.min(MAX_VOICE_MS, Math.round(performance.now() - startedAt))
    recorder.stop()
  }
  recorder.start(1000)
  return { stop }
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('Could not read the recording.'))
    reader.readAsDataURL(blob)
  })
}
