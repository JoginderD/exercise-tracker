// Video kept in this browser (IndexedDB), never uploaded except clips the patient
// chose to share. 'recordings' holds full runs for the person to watch or download;
// 'clips' holds clips waiting to upload, so a closed tab or a lost connection
// retries later, like the session outbox in api.js.
const DB_NAME = 'exercise-tracker'
const STORES = ['recordings', 'clips']
// The oldest recordings are deleted past either limit, so storage cannot grow forever.
export const MAX_RECORDINGS = 10
export const MAX_RECORDING_BYTES = 1024 * 1024 * 1024

let opening
function open() {
  opening ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('This browser cannot store videos.'))
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath:'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open video storage.'))
  }).catch(error => { opening = null; throw error })
  return opening
}

async function run(store, mode, action) {
  const db = await open()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode)
    const request = action(transaction.objectStore(store))
    transaction.oncomplete = () => resolve(request?.result)
    transaction.onerror = () => reject(transaction.error ?? new Error('Video storage failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Video storage is full.'))
  })
}

export const putVideo = (store, value) => run(store, 'readwrite', objects => objects.put(value))
export const getVideos = store => run(store, 'readonly', objects => objects.getAll())
export const deleteVideo = (store, id) => run(store, 'readwrite', objects => objects.delete(id))

// Saves a full recording, then trims the oldest ones past the limits.
export async function saveRecording(recording) {
  await putVideo('recordings', recording)
  const all = (await getVideos('recordings')).sort((a, b) => b.startedAt - a.startedAt)
  let bytes = 0
  for (const [index, item] of all.entries()) {
    bytes += item.blob.size
    if (index >= MAX_RECORDINGS || (index > 0 && bytes > MAX_RECORDING_BYTES)) await deleteVideo('recordings', item.id)
  }
}
