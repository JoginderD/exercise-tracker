// Records a video question (picture and sound) for the patient's coach with MediaRecorder.
// While the tracker runs, its camera is reused (a clone of the track, so pressing Stop on
// the tracker does not cut the question short); otherwise the camera is opened here.
// About 600 kbit/s keeps the two-minute limit near 9 MB. Safari records MP4.
export const MAX_QUESTION_MS = 2 * 60 * 1000
const TYPES = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']

export const videoQuestionSupported = () =>
  typeof MediaRecorder === 'function' && Boolean(navigator.mediaDevices?.getUserMedia)

// Which devices a recording needs: the tracker's camera is reused while it runs.
export const devicesNeeded = cameraTrack => cameraTrack?.readyState === 'live' ? ['microphone'] : ['camera', 'microphone']

// 'granted', 'denied' or 'prompt' per device, or 'unknown' where the browser will not
// say (Firefox and Safari do not answer for the camera or microphone).
export async function permissionStates(devices) {
  return Object.fromEntries(await Promise.all(devices.map(async name => {
    try { return [name, (await navigator.permissions.query({ name })).state] }
    catch { return [name, 'unknown'] }
  })))
}

// onStop({ blob, type, durationMs }) runs when stop() is called, the time limit is reached
// or the camera or microphone goes away; never after cancel(). stream is for a live preview.
// Throws if the camera or microphone cannot be opened.
export async function startVideoQuestion({ cameraTrack = null, onStop, onTick = () => {} }) {
  const live = cameraTrack?.readyState === 'live' ? cameraTrack : null
  const own = await navigator.mediaDevices.getUserMedia({
    audio:{ echoCancellation:true, noiseSuppression:true },
    video:live ? false : { width:{ ideal:640 }, height:{ ideal:480 }, facingMode:'user' },
  })
  const picture = live ? live.clone() : own.getVideoTracks()[0]
  const tracks = [picture, ...own.getAudioTracks()]
  const stream = new MediaStream(tracks)
  const mimeType = TYPES.find(type => MediaRecorder.isTypeSupported(type))
  const recorder = new MediaRecorder(stream, { ...mimeType ? { mimeType } : {}, videoBitsPerSecond:600_000, audioBitsPerSecond:32_000 })
  const chunks = []
  const startedAt = performance.now()
  let durationMs = 0
  let cancelled = false
  const tick = setInterval(() => {
    const elapsed = performance.now() - startedAt
    onTick(elapsed)
    if (elapsed >= MAX_QUESTION_MS) stop()
  }, 250)
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
  recorder.onstop = () => {
    clearInterval(tick)
    tracks.forEach(track => track.stop())
    if (cancelled) return
    // The server checks the plain type; codecs are only a hint for the browser.
    const type = (recorder.mimeType || mimeType || 'video/webm').split(';')[0]
    onStop({ blob:new Blob(chunks, { type }), type, durationMs })
  }
  for (const track of tracks) track.addEventListener('ended', () => stop())
  function stop() {
    if (recorder.state === 'inactive') return
    durationMs = Math.min(MAX_QUESTION_MS, Math.round(performance.now() - startedAt))
    recorder.stop()
  }
  function cancel() {
    cancelled = true
    if (recorder.state === 'inactive') tracks.forEach(track => track.stop())
    else recorder.stop()
    clearInterval(tick)
  }
  recorder.start(1000)
  return { stop, cancel, stream }
}
