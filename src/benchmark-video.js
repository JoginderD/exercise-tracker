// A paused, detached video decodes a local clip. The same canvas is reused only
// after both models have consumed the previous frame synchronously.
export function createVideoDecoder({ file, maxSide = 640, timeoutMs = 5000 }) {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not initialize the benchmark canvas.')
  const url = URL.createObjectURL(file)
  let disposed = false

  function waitFor(events, condition, action, signal, description) {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        for (const event of events) video.removeEventListener(event, check)
        video.removeEventListener('error', fail)
        signal?.removeEventListener('abort', cancel)
      }
      const finish = error => {
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const check = () => { if (condition()) finish() }
      const fail = () => finish(new Error('Could not decode the clip. Try an H.264 MP4 or WebM file.'))
      const cancel = () => finish(signal.reason)
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${description}.`)), timeoutMs)
      for (const event of events) video.addEventListener(event, check)
      video.addEventListener('error', fail)
      signal?.addEventListener('abort', cancel, { once:true })
      try {
        action?.()
        if (video.error) fail()
        else check()
      } catch (error) { finish(error) }
    })
  }

  async function open(signal) {
    await waitFor(['loadeddata', 'canplay'], () => video.readyState >= 2, () => {
      video.src = url
      video.load()
    }, signal, 'the first decoded frame')
    if (!(video.videoWidth > 0 && video.videoHeight > 0 && video.duration > 0 && Number.isFinite(video.duration))) {
      throw new Error('Choose a video clip with a finite duration and a video track.')
    }
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight))
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    return { durationMs:video.duration * 1000 }
  }

  async function readFrame(timeMs, signal) {
    if (disposed) throw new Error('The video decoder has been closed.')
    const seconds = timeMs / 1000
    if (Math.abs(video.currentTime - seconds) > 0.000001) {
      await waitFor(['seeked'], () => !video.seeking && Math.abs(video.currentTime - seconds) < 0.001,
        () => { video.currentTime = seconds }, signal, `the seek to ${timeMs} ms`)
    }
    await waitFor(['loadeddata', 'canplay'], () => !video.seeking && video.readyState >= 2,
      null, signal, `a decoded frame at ${timeMs} ms`)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas
  }

  function dispose() {
    if (disposed) return
    disposed = true
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }

  return { open, readFrame, dispose }
}
