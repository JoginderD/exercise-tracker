import { deleteVideo, getVideos, putVideo } from './device-store.js'

// Thin wrapper over the server API. Errors carry the server's message and status
// so every caller can show the user what went wrong.
// problems: per-line reasons a CSV plan was refused (server/index.js).
export class ApiError extends Error {
  constructor(message, status, problems) { super(message); this.status = status; this.problems = problems }
}

// raw sends a Blob as the body as-is, with its own type and any extra headers.
export async function api(method, path, body, { keepalive = false, raw = null, headers = {} } = {}) {
  let response
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials:'same-origin',
      keepalive,
      headers:raw ? { 'content-type':raw.type, ...headers } : body ? { 'content-type':'application/json' } : {},
      body:raw ?? (body ? JSON.stringify(body) : undefined),
    })
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', 0)
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(data.error ?? `Request failed (${response.status}).`, response.status, data.problems)
  return data
}

// Finished sessions are queued per account in localStorage before upload, so a
// failed save, a closed tab or an offline phone retries later instead of losing
// the session. The server ignores repeats of the same id, so retrying is safe.
const MAX_QUEUED = 200
const memory = new Map()
const key = userId => `exercise-tracker:outbox:${userId}`

function readQueue(userId) {
  try {
    const stored = JSON.parse(localStorage.getItem(key(userId)) ?? '[]')
    return Array.isArray(stored) ? stored : []
  } catch {
    return memory.get(userId) ?? []
  }
}
function writeQueue(userId, queue) {
  memory.set(userId, queue)
  try { localStorage.setItem(key(userId), JSON.stringify(queue)) } catch {}
}

// A clip's video, fetched as a Blob so it plays in every browser without range requests.
export async function fetchBlob(path) {
  let response
  try { response = await fetch(`/api${path}`, { credentials:'same-origin' }) }
  catch { throw new ApiError('Cannot reach the server. Check your connection.', 0) }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new ApiError(data.error ?? `Request failed (${response.status}).`, response.status)
  }
  return response.blob()
}

// Clips wait in IndexedDB (src/device-store.js) rather than localStorage, which is too
// small for video. A clip uploads only after its session is on the server (409 until
// then), so it is retried after the next session save. Retrying is safe: the server
// keys clips by their id.
export function createClipUploader(onChange) {
  let flushing = null
  return {
    async add(userId, sessionId, clips) {
      for (const clip of clips) await putVideo('clips', { ...clip, userId, sessionId })
    },
    flush(userId) {
      if (!userId) return Promise.resolve()
      flushing ??= (async () => {
        let sent = 0
        const queued = (await getVideos('clips').catch(() => [])).filter(clip => clip.userId === userId)
          .sort((a, b) => a.startedAt - b.startedAt)
        for (const clip of queued) {
          try {
            await api('PUT', `/sessions/${clip.sessionId}/clips/${clip.id}`, null, {
              raw:clip.blob,
              headers:{ 'x-clip-meta':encodeURIComponent(JSON.stringify({ startedAt:clip.startedAt, durationMs:clip.durationMs, labels:clip.labels })) },
            })
            await deleteVideo('clips', clip.id)
            sent++
          } catch (error) {
            // Its session is still in the session outbox: try again after that uploads.
            if (error.status === 409) continue
            // Sharing turned off, an invalid or oversized clip, or a full session: never retried.
            if ([400, 403, 413, 422].includes(error.status)) {
              await deleteVideo('clips', clip.id)
              onChange({ type:'rejected', clip, error })
              continue
            }
            onChange({ type:'failed', clip, error })
            break
          }
        }
        if (sent) onChange({ type:'sent', count:sent })
      })().finally(() => { flushing = null })
      return flushing
    },
  }
}

export function createOutbox(onChange) {
  let flushing = null
  const outbox = {
    pending:userId => readQueue(userId).length,
    records:userId => readQueue(userId),
    add(userId, record) {
      const queue = readQueue(userId).filter(item => item.id !== record.id)
      queue.push(record)
      writeQueue(userId, queue.slice(-MAX_QUEUED))
      onChange({ type:'queued', record })
    },
    // Uploads oldest first and stops at the first retryable failure.
    flush(userId, { keepalive = false } = {}) {
      if (!userId) return Promise.resolve()
      // Cleared in .finally, which always runs after the assignment. A finally block inside
      // the async function would run synchronously on an empty queue, before ??= assigns,
      // leaving a settled promise that blocked every later upload.
      flushing ??= (async () => {
        for (const record of readQueue(userId)) {
          const remove = () => writeQueue(userId, readQueue(userId).filter(item => item.id !== record.id))
          try {
            await api('POST', '/sessions', record, { keepalive })
            remove()
            onChange({ type:'saved', record })
          } catch (error) {
            // A 400 means the record itself is invalid; retrying would never succeed.
            if (error.status !== 400) { onChange({ type:'failed', record, error }); return }
            remove()
            onChange({ type:'rejected', record, error })
          }
        }
      })().finally(() => { flushing = null })
      return flushing
    },
  }
  return outbox
}
