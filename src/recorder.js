import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer'
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer'

// Records what the tracker shows (camera picture plus the drawn skeleton) with one
// WebCodecs encoder. Every encoded frame is kept, with a keyframe each second, so
// both the full recording and any clip are cut from the same stream without
// encoding twice: a clip starts at the last keyframe before its window.
// H.264 in MP4 plays everywhere; VP8 in WebM is the fallback where H.264 cannot be encoded.
const CODECS = [
  { codec:'avc1.42E01F', container:'mp4', type:'video/mp4', extra:{ avc:{ format:'avc' } } },
  { codec:'vp8', container:'webm', type:'video/webm', extra:{} },
]
const LONGEST_EDGE = 640
const BITRATE = 800_000
const KEYFRAME_MS = 1000
// Past this the full recording is dropped (about 120 MB held in memory) and only
// the recent stretch needed for clips is kept.
export const MAX_FULL_MS = 20 * 60 * 1000
const RING_MS = 30 * 1000
// Frames are skipped rather than queued past this, so recording never adds lag to
// tracking. It is generous because a hardware H.264 encoder can hold ~50 frames
// before its first output; a small limit starves it of input and it never starts.
const MAX_QUEUE = 60
// No output for this long while frames are queued means the encoder has stalled.
const STALL_MS = 5000

export const recordingSupported = () => typeof VideoEncoder === 'function' && typeof VideoFrame === 'function'

const even = value => Math.max(2, Math.round(value / 2) * 2)

// keepFull: whether to hold the whole run for the device copy (clips work either way).
export async function createRecorder({ width, height, keepFull = true, onError = () => {} }) {
  if (!recordingSupported()) return null
  const scale = Math.min(1, LONGEST_EDGE / Math.max(width, height))
  const size = { width:even(width * scale), height:even(height * scale) }
  let format = null
  for (const option of CODECS) {
    const config = { codec:option.codec, ...size, bitrate:BITRATE, framerate:30, latencyMode:'realtime', ...option.extra }
    const support = await VideoEncoder.isConfigSupported(config).catch(() => null)
    if (support?.supported) { format = { ...option, config }; break }
  }
  if (!format) return null

  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d', { alpha:false })
  // { data, type, timestamp (µs), duration (µs) }
  let chunks = []
  let decoderConfig = null
  let lastKeyAt = -Infinity
  let failed = false
  let full = keepFull
  let warming = true
  // Wall-clock time the encoder last made progress while it had frames waiting.
  let progressAt = null

  const encoder = new VideoEncoder({
    output(chunk, meta) {
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig
      progressAt = performance.now()
      if (warming) return
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      const previous = chunks.at(-1)
      if (previous && !previous.duration) previous.duration = chunk.timestamp - previous.timestamp
      chunks.push({ data, type:chunk.type, timestamp:chunk.timestamp, duration:chunk.duration ?? 0 })
      trim(chunk.timestamp)
    },
    error(error) {
      failed = true
      onError(error)
    },
  })
  encoder.configure(format.config)
  // A cold hardware encoder takes a second or two to produce anything; one blank
  // frame and a flush pay that cost now rather than during the first reps.
  try {
    ctx.fillRect(0, 0, size.width, size.height)
    const blank = new VideoFrame(canvas, { timestamp:0 })
    encoder.encode(blank, { keyFrame:true })
    blank.close()
    await encoder.flush()
  } catch (error) {
    if (encoder.state !== 'closed') encoder.close()
    onError(error)
    return null
  }
  warming = false

  // Without the full recording, keep only from the last keyframe before the ring window.
  function trim(nowUs) {
    if (full && nowUs - chunks[0].timestamp > MAX_FULL_MS * 1000) full = false
    if (full) return
    const from = nowUs - RING_MS * 1000
    let keep = 0
    for (let i = 0; i < chunks.length && chunks[i].timestamp <= from; i++) if (chunks[i].type === 'key') keep = i
    if (keep > 0) chunks = chunks.slice(keep)
  }

  function mux(list) {
    if (!list.length || !decoderConfig) return null
    const mp4 = format.container === 'mp4'
    const target = mp4 ? new Mp4Target() : new WebmTarget()
    const muxer = mp4
      ? new Mp4Muxer({ target, video:{ codec:'avc', ...size }, fastStart:'in-memory', firstTimestampBehavior:'offset' })
      : new WebmMuxer({ target, video:{ codec:'V_VP8', ...size }, firstTimestampBehavior:'offset' })
    list.forEach((chunk, index) => {
      const meta = index === 0 ? { decoderConfig } : undefined
      if (mp4) muxer.addVideoChunkRaw(chunk.data, chunk.type, chunk.timestamp, chunk.duration || 33333, meta)
      else muxer.addVideoChunkRaw(chunk.data, chunk.type, chunk.timestamp, meta)
    })
    muxer.finalize()
    return new Blob([target.buffer], { type:format.type })
  }

  return {
    type:format.type,
    get keepsFull() { return full },
    // Draws the current picture and overlay and encodes it; now is performance.now() ms.
    addFrame(video, overlay, now) {
      if (failed || encoder.state !== 'configured') return
      if (!encoder.encodeQueueSize) progressAt = performance.now()
      else if (performance.now() - progressAt > STALL_MS) {
        failed = true
        onError(new Error('the video encoder stopped responding'))
        return
      }
      if (encoder.encodeQueueSize > MAX_QUEUE) return
      ctx.drawImage(video, 0, 0, size.width, size.height)
      ctx.drawImage(overlay, 0, 0, size.width, size.height)
      const frame = new VideoFrame(canvas, { timestamp:Math.round(now * 1000) })
      const keyFrame = now - lastKeyAt >= KEYFRAME_MS
      if (keyFrame) lastKeyAt = now
      try { encoder.encode(frame, { keyFrame }) }
      finally { frame.close() }
    },
    // The stretch [start, end] (performance.now() ms) as a playable file, starting
    // at the keyframe before start. null if that stretch is no longer held.
    clip(start, end) {
      let from = -1
      for (let i = 0; i < chunks.length && chunks[i].timestamp <= start * 1000; i++) if (chunks[i].type === 'key') from = i
      if (from < 0) from = chunks.findIndex(chunk => chunk.type === 'key')
      if (from < 0) return null
      const list = chunks.slice(from).filter(chunk => chunk.timestamp <= end * 1000)
      const blob = mux(list)
      return blob && { blob, start:list[0].timestamp / 1000, durationMs:(list.at(-1).timestamp - list[0].timestamp) / 1000 + 33 }
    },
    // Waits for frames still being encoded. Call before cutting the last clips.
    async flush() {
      if (!failed && encoder.state === 'configured') await encoder.flush().catch(() => {})
    },
    // The whole run, if it was kept; releases the encoder either way.
    finish() {
      const blob = full && !failed ? mux(chunks) : null
      const durationMs = chunks.length ? (chunks.at(-1).timestamp - chunks[0].timestamp) / 1000 : 0
      if (encoder.state !== 'closed') encoder.close()
      chunks = []
      return blob && { blob, durationMs }
    },
    close() {
      if (encoder.state !== 'closed') encoder.close()
      chunks = []
    },
  }
}
