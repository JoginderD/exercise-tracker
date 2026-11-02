// Thin wrapper over the server API. Errors carry the server's message and status
// so every caller can show the user what went wrong.
export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status }
}

export async function api(method, path, body, { keepalive = false } = {}) {
  let response
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials:'same-origin',
      keepalive,
      headers:body ? { 'content-type':'application/json' } : {},
      body:body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', 0)
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(data.error ?? `Request failed (${response.status}).`, response.status)
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

export function createOutbox(onChange) {
  let flushing = null
  const outbox = {
    pending:userId => readQueue(userId).length,
    add(userId, record) {
      const queue = readQueue(userId).filter(item => item.id !== record.id)
      queue.push(record)
      writeQueue(userId, queue.slice(-MAX_QUEUED))
      onChange({ type:'queued', record })
    },
    // Uploads oldest first and stops at the first retryable failure.
    flush(userId, { keepalive = false } = {}) {
      if (!userId) return Promise.resolve()
      flushing ??= (async () => {
        try {
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
        } finally {
          flushing = null
        }
      })()
      return flushing
    },
  }
  return outbox
}
