import { deleteVideo, getVideos } from './device-store.js'
import { exercises } from './exercises.js'

// Full recordings kept in this browser: watch, download or delete. Hidden while
// there are none. Deleting waits a few seconds with an Undo before it happens.
const UNDO_MS = 6000
const exerciseName = id => exercises.find(exercise => exercise.id === id)?.name ?? id
const when = ms => new Date(ms).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' })
const length = ms => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`
const megabytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function el(tag, props = {}, ...children) {
  const element = Object.assign(document.createElement(tag), props)
  element.append(...children.filter(child => child !== null && child !== undefined))
  return element
}

export function createRecordingsPanel(section) {
  const list = el('ul', { className:'recording-list' })
  const message = el('p', { className:'form-message' })
  message.setAttribute('role', 'status')
  const player = el('video', { controls:true, playsInline:true, hidden:true, className:'recording-player' })
  section.append(
    el('h2', { id:'recordings-title' }, 'Recordings on this device'),
    el('p', { className:'hint' }, 'Kept only in this browser, never uploaded. The 10 most recent are kept.'),
    player, list, message,
  )
  let playingUrl = null
  // id -> timer for deletes that can still be undone.
  const pendingDelete = new Map()

  function stopPlayer() {
    player.pause()
    player.hidden = true
    player.removeAttribute('src')
    if (playingUrl) URL.revokeObjectURL(playingUrl)
    playingUrl = null
  }

  function row(recording) {
    const play = el('button', { type:'button', className:'secondary', textContent:'Play' })
    play.addEventListener('click', () => {
      stopPlayer()
      playingUrl = URL.createObjectURL(recording.blob)
      player.src = playingUrl
      player.hidden = false
      player.play().catch(() => {})
    })
    const download = el('button', { type:'button', className:'secondary', textContent:'Download' })
    download.addEventListener('click', () => {
      const url = URL.createObjectURL(recording.blob)
      const extension = recording.type.includes('mp4') ? 'mp4' : 'webm'
      const date = new Date(recording.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')
      el('a', { href:url, download:`${recording.exercise}-${date}.${extension}` }).click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    })
    const remove = el('button', { type:'button', className:'secondary', textContent:'Delete' })
    remove.addEventListener('click', () => scheduleDelete(recording, item))
    const item = el('li', {},
      el('span', {}, `${when(recording.startedAt)} · ${exerciseName(recording.exercise)} · ${length(recording.durationMs)} · ${megabytes(recording.blob.size)}`),
      el('span', { className:'button-row' }, play, download, remove),
    )
    return item
  }

  function scheduleDelete(recording, item) {
    stopPlayer()
    item.hidden = true
    const undo = el('button', { type:'button', className:'link-button', textContent:'Undo' })
    message.dataset.state = ''
    message.replaceChildren(`Recording from ${when(recording.startedAt)} deleted. `, undo)
    const timer = setTimeout(async () => {
      pendingDelete.delete(recording.id)
      try {
        await deleteVideo('recordings', recording.id)
        if (message.contains(undo)) message.replaceChildren()
      } catch (error) {
        item.hidden = false
        message.dataset.state = 'error'
        message.textContent = `Could not delete the recording: ${error.message}`
      }
      refresh()
    }, UNDO_MS)
    pendingDelete.set(recording.id, timer)
    undo.addEventListener('click', () => {
      clearTimeout(timer)
      pendingDelete.delete(recording.id)
      message.replaceChildren('Recording kept.')
      refresh()
    })
  }

  async function refresh() {
    try {
      const recordings = (await getVideos('recordings')).filter(item => !pendingDelete.has(item.id))
        .sort((a, b) => b.startedAt - a.startedAt)
      section.hidden = !recordings.length && !pendingDelete.size
      list.replaceChildren(...recordings.map(row))
    } catch (error) {
      // No IndexedDB (some private windows): nothing was kept, so there is nothing to show.
      section.hidden = true
    }
  }
  refresh()
  return { refresh }
}
