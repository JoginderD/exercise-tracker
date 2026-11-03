import { api } from './api.js'
import { h, withPending } from './dom.js'
import { MAX_QUESTION_MS, devicesNeeded, permissionStates, startVideoQuestion, videoQuestionSupported } from './question-recorder.js'
import { startTranscript, transcriptReason } from './transcriber.js'

const MAX_TEXT = 2000
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
const megabytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const deviceList = devices => devices.join(' and ')
// The browser holds a camera or microphone request open, with no error, until its
// permission prompt is answered; these say what is happening while it waits.
const PROMPT_HINT_MS = 1500
const GIVE_UP_MS = 30 * 1000
// The question's details travel in a request header (the body is the video). Servers
// refuse headers past 16 KB, so a very long transcript in a non-Latin script is shortened.
const MAX_META_CHARS = 12000
function questionMeta(meta) {
  let transcript = meta.transcript
  let header
  while ((header = encodeURIComponent(JSON.stringify({ ...meta, transcript }))).length > MAX_META_CHARS) {
    transcript = transcript.slice(0, Math.floor(transcript.length * 0.9))
  }
  return header
}
// Why the browser refused, worded for the patient.
function startError(error, devices) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return `Access to the ${deviceList(devices)} is blocked. Allow it from the icon at the left of the address bar, then press Record again. You can also type your question.`
  }
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return `No ${deviceList(devices)} found on this device. You can type your question instead.`
  if (error?.name === 'NotReadableError' || error?.name === 'AbortError') {
    return `The ${deviceList(devices)} could not be opened. Another app may be using it; close that app and try again.`
  }
  return `Could not start the ${deviceList(devices)}${error?.message ? ` (${error.message})` : ''}. You can type your question instead.`
}

// "Ask your coach", floating in the bottom-right of the camera picture (and so in full
// screen too). Closed it is two small controls: a field to type into and a record button.
// Typing opens a larger box; recording shows a preview, then asks to send, re-record or cancel.
// cameraTrack: the tracker's live camera track, or null while it is off.
export function createAskWidget({ stage, cameraTrack }) {
  let coaches = []
  let mode = 'closed'
  let capture = null
  let transcript = null
  let transcriptProblem = null
  // Bumped by every start and cancel, so a camera that opens after Cancel is closed again.
  let attempt = 0
  let recording = null
  let recordingUrl = null
  // One id per question being written or recorded, so a double-click or a retry after
  // a lost response stores it once. A new id is made only after a send succeeds.
  let draftId = crypto.randomUUID()
  let noticeTimer

  const message = h('p', { className:'form-message ask-message', role:'status' })
  const coach = h('select', { 'aria-label':'Coach' })
  const coachRow = h('label', { className:'ask-coach' }, 'To ', coach)
  const coachName = () => coaches.find(item => String(item.id) === coach.value)?.name ?? 'your coach'

  // Closed: looks like a text field, plus a clearly labelled record button.
  const openType = h('button', { type:'button', className:'ask-field' }, 'Ask your coach…')
  const openRecord = h('button', { type:'button', className:'ask-record' }, h('span', { className:'rec-dot', 'aria-hidden':'true' }), 'Record video question')
  const closed = h('div', { className:'ask-closed' }, openType, openRecord)

  const text = h('textarea', { rows:4, maxlength:MAX_TEXT, placeholder:'Type your question…', 'aria-label':'Question for your coach' })
  const sendText = h('button', { type:'submit' }, 'Send')
  const typeForm = h('form', { className:'ask-typing', novalidate:true },
    h('div', { className:'ask-head' }, h('strong', {}, 'Ask your coach'), h('button', { type:'button', className:'link-button', onclick:() => setMode('closed') }, 'Close')),
    text,
    h('div', { className:'ask-actions' }, sendText,
      h('button', { type:'button', className:'secondary', onclick:() => startRecording() }, 'Record video instead')),
    h('a', { href:'#sessions', className:'ask-link' }, 'Your questions and replies'),
  )

  const livePreview = h('video', { muted:true, playsinline:true, autoplay:true, className:'ask-video' })
  const timer = h('p', { className:'ask-timer', role:'status' })
  const caption = h('p', { className:'ask-caption', 'aria-live':'polite' })
  const stopButton = h('button', { type:'button', className:'stop-button' }, 'Stop recording')
  const recordingView = h('div', { className:'ask-recording' }, livePreview, timer, caption,
    h('div', { className:'ask-actions' }, stopButton, h('button', { type:'button', className:'secondary', onclick:() => cancelAll() }, 'Cancel')))

  const playback = h('video', { controls:true, playsinline:true, className:'ask-video' })
  const reviewQuestion = h('p', { className:'ask-question' })
  const transcriptBox = h('textarea', { rows:3, maxlength:MAX_TEXT, 'aria-label':'Transcript of your question' })
  const transcriptNote = h('span', { className:'ask-transcript-note' })
  const sendVideo = h('button', { type:'button' }, 'Send')
  const reviewView = h('div', { className:'ask-review' }, playback, reviewQuestion,
    h('label', { className:'ask-transcript' }, transcriptNote, transcriptBox),
    h('div', { className:'ask-actions' }, sendVideo,
      h('button', { type:'button', className:'secondary', onclick:() => startRecording() }, 'Re-record'),
      h('button', { type:'button', className:'secondary', onclick:() => cancelAll() }, 'Cancel')))

  const element = h('div', { className:'ask', 'data-mode':'closed', hidden:true }, closed, coachRow, typeForm, recordingView, reviewView, message)
  stage.append(element)

  function setMode(next) {
    mode = next
    element.dataset.mode = next
    // A coach choice only matters while there is something to send.
    coachRow.hidden = coaches.length < 2 || next === 'closed' || next === 'recording'
    openType.textContent = text.value.trim() ? 'Continue your question…' : 'Ask your coach…'
    stage.classList.toggle('ask-open', next !== 'closed')
    if (next === 'typing') text.focus()
  }
  function notice(textContent, state = '') {
    clearTimeout(noticeTimer)
    message.dataset.state = state
    message.textContent = textContent
    if (state === 'within') noticeTimer = setTimeout(() => { message.textContent = '' }, 8000)
  }
  function clearRecording() {
    recording = null
    if (recordingUrl) URL.revokeObjectURL(recordingUrl)
    recordingUrl = null
    playback.removeAttribute('src')
    playback.load()
  }
  function stopTranscript() {
    transcript?.cancel()
    transcript = null
    caption.textContent = ''
  }
  function cancelAll() {
    attempt++
    stopTranscript()
    capture?.cancel()
    capture = null
    livePreview.srcObject = null
    clearRecording()
    notice('')
    setMode('closed')
  }

  async function startRecording() {
    if (!videoQuestionSupported()) { notice('Video recording is not available in this browser. You can type your question instead.', 'error'); return }
    capture?.cancel()
    capture = null
    stopTranscript()
    const mine = ++attempt
    const track = cameraTrack()
    const devices = devicesNeeded(track)
    clearRecording()
    notice('')
    // Already blocked: say so now rather than waiting on a prompt that will never show.
    const states = await permissionStates(devices)
    if (mine !== attempt) return
    const blocked = devices.filter(name => states[name] === 'denied')
    if (blocked.length) {
      setMode('closed')
      notice(startError({ name:'NotAllowedError' }, blocked), 'error')
      return
    }
    setMode('recording')
    timer.dataset.state = 'starting'
    timer.textContent = `Starting the ${deviceList(devices)}…`
    stopButton.hidden = true
    const asking = devices.filter(name => states[name] !== 'granted')
    const hint = setTimeout(() => {
      if (mine !== attempt || capture) return
      timer.textContent = `Waiting for you to allow the ${deviceList(asking.length ? asking : devices)}. Look for the browser's prompt by the address bar` +
        `${document.fullscreenElement || document.webkitFullscreenElement ? ' (exit full screen if you cannot see it)' : ''}.`
    }, PROMPT_HINT_MS)
    // A prompt left unanswered, or a browser that never answers: stop waiting and say so.
    // A late answer is closed again, as the attempt has moved on.
    const giveUp = setTimeout(() => {
      if (mine !== attempt || capture) return
      attempt++
      setMode('closed')
      notice(`The browser did not open the ${deviceList(devices)}. Check its permission prompt or settings, then press Record again.`, 'error')
    }, GIVE_UP_MS)
    try {
      const started = await startVideoQuestion({
        cameraTrack:track,
        onTick:ms => { timer.textContent = `Recording ${clock(ms)} of ${clock(MAX_QUESTION_MS)}` },
        onStop:async result => {
          capture = null
          livePreview.srcObject = null
          // The recogniser may still be delivering the last sentence.
          const listening = transcript
          transcript = null
          timer.dataset.state = ''
          timer.textContent = listening ? 'Finishing the transcript…' : ''
          const words = listening ? await listening.stop() : ''
          caption.textContent = ''
          if (mine !== attempt) return
          if (result.blob.size === 0 || result.durationMs < 1000) {
            notice('That recording was too short. Record again, or cancel.', 'warning')
            setMode('closed')
            return
          }
          recording = result
          recordingUrl = URL.createObjectURL(result.blob)
          playback.src = recordingUrl
          transcriptBox.value = words.slice(0, MAX_TEXT)
          transcriptBox.placeholder = words ? '' : 'Optional: type what you asked, so your coach can read it.'
          transcriptNote.textContent = words
            ? 'Transcript, made automatically. Fix any mistakes before sending:'
            : `No transcript${transcriptProblem ? `: ${transcriptReason(transcriptProblem)}` : ': no words were picked up'}.`
          reviewQuestion.textContent = `Send this ${clock(result.durationMs)} video to ${coachName()}?`
          setMode('review')
        },
      })
      if (mine !== attempt) { started.cancel(); return }
      capture = started
      livePreview.srcObject = capture.stream
      livePreview.play().catch(() => {})
      timer.dataset.state = 'recording'
      timer.textContent = 'Recording…'
      stopButton.hidden = false
      // Words appear under the preview as they are recognised.
      transcriptProblem = null
      transcript = startTranscript({
        onText:text => { if (mine === attempt) caption.textContent = text },
        onUnavailable:code => { if (mine === attempt) transcriptProblem = code },
      })
    } catch (error) {
      if (mine !== attempt) return
      capture = null
      setMode('closed')
      notice(startError(error, devices), 'error')
    } finally {
      clearTimeout(hint)
      clearTimeout(giveUp)
    }
  }
  stopButton.addEventListener('click', () => capture?.stop())
  openRecord.addEventListener('click', startRecording)
  openType.addEventListener('click', () => { notice(''); setMode('typing') })
  coach.addEventListener('change', () => {
    if (recording) reviewQuestion.textContent = `Send this ${clock(recording.durationMs)} video to ${coachName()}?`
  })

  const sent = question => {
    draftId = crypto.randomUUID()
    notice(`Sent to ${question.coachName}. They see it as high priority, and their reply shows under My sessions.`, 'within')
  }
  typeForm.addEventListener('submit', event => {
    event.preventDefault()
    if (sendText.disabled) return
    if (!text.value.trim()) { notice('Type your question first.', 'error'); return }
    withPending(sendText, 'Sending…', message, async () => {
      const result = await api('POST', '/questions', { id:draftId, coachId:Number(coach.value), text:text.value })
      text.value = ''
      setMode('closed')
      sent(result.question)
    })
  })
  // A failed upload stays on the review screen, so Send retries the same video and id.
  sendVideo.addEventListener('click', () => withPending(sendVideo, `Sending ${megabytes(recording.blob.size)}…`, message, async () => {
    const result = await api('PUT', `/questions/${draftId}`, null, {
      raw:recording.blob,
      headers:{ 'x-question-meta':questionMeta({ coachId:Number(coach.value), durationMs:recording.durationMs, transcript:transcriptBox.value.trim() }) },
    })
    clearRecording()
    setMode('closed')
    sent(result.question)
  }))

  // Escape closes the box rather than leaving full screen.
  element.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || mode !== 'typing') return
    event.stopPropagation()
    setMode('closed')
  })

  return {
    // Shown only to a signed-in patient who shares with at least one coach.
    setCoaches(list) {
      coaches = list
      const chosen = coach.value
      coach.replaceChildren(...list.map(item => h('option', { value:item.id }, item.name)))
      if (list.some(item => String(item.id) === chosen)) coach.value = chosen
      element.hidden = !list.length
      stage.classList.toggle('has-ask', list.length > 0)
      if (!list.length) cancelAll()
      else setMode(mode)
    },
    // Leaving the tracker page stops a recording in progress; a typed draft is kept.
    stop() {
      if (mode === 'recording' || mode === 'review') cancelAll()
    },
  }
}
