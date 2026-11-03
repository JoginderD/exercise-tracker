import { api, fetchBlob } from './api.js'
import { h, plural, when, withPending } from './dom.js'
import { MAX_VOICE_MS, blobToBase64, startVoice, voiceSupported } from './voice.js'

const MAX_TEXT = 2000
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

// One shared player per list, so only one recording plays at a time.
function audioPlayer() {
  const element = h('audio', { controls:true, hidden:true, className:'question-audio' })
  let url = null
  return {
    element,
    async play(question) {
      const blob = await fetchBlob(`/questions/${question.id}/audio`)
      if (url) URL.revokeObjectURL(url)
      url = URL.createObjectURL(blob)
      element.src = url
      element.hidden = false
      element.play().catch(() => {})
    },
  }
}

// A question with its reply. asCoach adds a reply form while it is unanswered.
function questionItem(question, { player, asCoach = false, showPatient = false, onAnswered = () => {} }) {
  const message = h('p', { className:'form-message', role:'status' })
  const who = asCoach
    ? showPatient ? h('a', { href:`#patients/${question.patientId}` }, question.patientName) : null
    : `To ${question.coachName}`
  const item = h('li', { className:'question', 'data-state':question.answeredAt ? 'answered' : 'open' })

  function body() {
    const listen = question.audio ? h('button', { type:'button', className:'secondary' }, `Play recording (${clock(question.audio.durationMs)})`) : null
    listen?.addEventListener('click', () => withPending(listen, 'Loading…', message, () => player.play(question)))
    const reply = question.answeredAt
      ? h('div', { className:'question-answer' }, h('p', { className:'hint' }, `${asCoach ? 'You' : question.coachName} replied ${when(question.answeredAt)}`),
        h('p', {}, question.answer))
      : asCoach ? replyForm() : h('p', { className:'hint' }, 'Waiting for a reply.')
    item.dataset.state = question.answeredAt ? 'answered' : 'open'
    item.replaceChildren(
      h('p', { className:'question-meta' }, who, who ? ' · ' : null, when(question.createdAt),
        question.answeredAt ? null : h('span', { className:'priority-badge' }, asCoach ? 'High priority' : 'Sent')),
      question.text ? h('p', { className:'question-text' }, question.text) : h('p', { className:'hint' }, 'Voice question'),
      listen, reply, message,
    )
  }

  function replyForm() {
    const text = h('textarea', { rows:3, maxlength:MAX_TEXT, 'aria-label':'Reply', placeholder:'Type your reply…' })
    const send = h('button', { type:'submit' }, 'Send reply')
    const form = h('form', { className:'question-reply' }, text, h('div', { className:'button-row' }, send))
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (!text.value.trim()) { message.dataset.state = 'error'; message.textContent = 'Type a reply first.'; return }
      withPending(send, 'Sending…', message, async () => {
        question = (await api('POST', `/questions/${question.id}/answer`, { text:text.value })).question
        body()
        message.dataset.state = 'within'
        message.textContent = 'Reply sent. The patient sees it under My sessions.'
        onAnswered(question)
      })
    })
    return form
  }

  body()
  return item
}

// A list that a refresh must not wipe while someone is typing a reply in it.
const typingIn = element => [...element.querySelectorAll('textarea')].some(area => area.value.trim() || area === document.activeElement)

// A paged list, newest first, reloaded from the top by load().
function pagedQuestions(path, itemOptions, emptyText) {
  const player = audioPlayer()
  const list = h('ul', { className:'item-list question-list' })
  const message = h('p', { className:'form-message', role:'status' })
  const more = h('button', { type:'button', className:'secondary', hidden:true }, 'Load more')
  let cursor = null
  async function page(fromTop) {
    more.disabled = true
    try {
      const result = await api('GET', `${path}?limit=25${!fromTop && cursor ? `&before=${cursor}` : ''}`)
      const items = result.questions.map(question => questionItem(question, { player, ...itemOptions }))
      if (fromTop) list.replaceChildren(...items)
      else list.append(...items)
      cursor = result.next
      more.hidden = !cursor
      message.dataset.state = ''
      message.textContent = list.children.length ? '' : emptyText
    } catch (error) {
      message.dataset.state = 'error'
      message.textContent = error.message
    } finally {
      more.disabled = false
    }
  }
  more.addEventListener('click', () => page(false))
  return {
    element:h('div', {}, player.element, list, message, more),
    load:() => typingIn(list) ? Promise.resolve() : page(true),
    prepend:question => { list.prepend(questionItem(question, { player, ...itemOptions })); message.textContent = '' },
  }
}

// The patient's side: ask one of their coaches, typed, spoken or both, and see replies.
export function patientQuestions({ coaches }) {
  const message = h('p', { className:'form-message', role:'alert' })
  const coach = h('select', { name:'coach', 'aria-label':'Coach' })
  const coachLabel = h('label', { className:'question-coach' }, 'Ask ', coach)
  const text = h('textarea', { name:'text', rows:4, maxlength:MAX_TEXT, placeholder:'Type your question, or record it below…', 'aria-label':'Question' })
  const record = h('button', { type:'button', className:'secondary' }, 'Record voice')
  const status = h('span', { className:'recording-status', role:'status' })
  const preview = h('audio', { controls:true, hidden:true, className:'question-audio' })
  const discard = h('button', { type:'button', className:'link-button', hidden:true }, 'Remove recording')
  const send = h('button', { type:'submit' }, 'Send question')
  const form = h('form', { className:'question-form', novalidate:true },
    coachLabel, text,
    h('div', { className:'button-row recording-row' }, record, status, discard),
    preview,
    h('div', { className:'button-row' }, send),
    message,
  )
  const history = pagedQuestions('/questions', {}, 'No questions yet.')
  const intro = h('p', { className:'hint' })
  const element = h('section', { className:'panel' }, h('h2', {}, 'Ask your coach'), intro, form, h('h3', { className:'subheading' }, 'Your questions'), history.element)

  // One id per question being written, so a double-click or a retry after a lost
  // response stores it once. A new id is made only after a send succeeds.
  let draftId = crypto.randomUUID()
  let voice = null
  let recording = null
  let previewUrl = null

  function clearRecording() {
    recording = null
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    previewUrl = null
    preview.hidden = true
    preview.removeAttribute('src')
    discard.hidden = true
    status.textContent = ''
    status.dataset.state = ''
    record.textContent = 'Record voice'
  }
  discard.addEventListener('click', clearRecording)

  if (!voiceSupported()) {
    record.disabled = true
    status.textContent = 'Recording is not available in this browser; you can still type.'
  }
  record.addEventListener('click', async () => {
    if (voice) { voice.stop(); return }
    clearRecording()
    message.textContent = ''
    record.disabled = true
    try {
      voice = await startVoice({
        onTick:ms => { status.textContent = `Recording ${clock(ms)} of ${clock(MAX_VOICE_MS)}` },
        onStop:result => {
          voice = null
          status.dataset.state = ''
          record.textContent = 'Record again'
          if (result.blob.size === 0 || result.durationMs < 500) {
            status.textContent = 'That recording was too short. Try again.'
            return
          }
          recording = result
          previewUrl = URL.createObjectURL(result.blob)
          preview.src = previewUrl
          preview.hidden = false
          discard.hidden = false
          status.textContent = `Recorded ${clock(result.durationMs)}. Listen back, then send.`
        },
      })
      record.textContent = 'Stop recording'
      status.textContent = 'Recording…'
      status.dataset.state = 'recording'
    } catch (error) {
      message.dataset.state = 'error'
      message.textContent = error?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it in your browser settings, or type your question instead.'
        : 'Could not start the microphone. You can type your question instead.'
    } finally {
      record.disabled = false
    }
  })

  form.addEventListener('submit', event => {
    event.preventDefault()
    if (send.disabled) return
    if (voice) { message.dataset.state = 'error'; message.textContent = 'Stop the recording before sending.'; return }
    if (!text.value.trim() && !recording) { message.dataset.state = 'error'; message.textContent = 'Type a question or record one first.'; return }
    withPending(send, 'Sending…', message, async () => {
      const audio = recording && { type:recording.type, durationMs:recording.durationMs, data:await blobToBase64(recording.blob) }
      const result = await api('POST', '/questions', { id:draftId, coachId:Number(coach.value), text:text.value, audio })
      draftId = crypto.randomUUID()
      text.value = ''
      clearRecording()
      if (!result.duplicate) history.prepend(result.question)
      message.dataset.state = 'within'
      message.textContent = `Sent to ${result.question.coachName}. Your coach sees it as high priority until they reply.`
    })
  })

  function setCoaches(list) {
    const chosen = coach.value
    coach.replaceChildren(...list.map(item => h('option', { value:item.id }, item.name)))
    if (list.some(item => String(item.id) === chosen)) coach.value = chosen
    coachLabel.hidden = list.length < 2
    form.hidden = !list.length
    intro.textContent = list.length
      ? `Type a question, record it, or both${list.length === 1 ? ` — it goes to ${list[0].name}` : ''}. Replies show up here.`
      : 'Share with a coach above, then you can send them questions here.'
  }
  setCoaches(coaches)
  history.load()
  return { element, setCoaches, load:history.load }
}

// The coach's inbox: every unanswered question, oldest first, on the patients page.
export function coachInbox({ onAnswered = () => {} } = {}) {
  const player = audioPlayer()
  const heading = h('h2', {}, 'Questions waiting')
  const list = h('ul', { className:'item-list question-list' })
  const message = h('p', { className:'hint' }, 'Loading questions…')
  const element = h('section', { className:'panel inbox' }, heading, player.element, list, message)
  function count() {
    const open = list.querySelectorAll('li[data-state="open"]').length
    heading.textContent = open ? `Questions waiting (${open})` : 'Questions waiting'
    element.dataset.state = open ? 'open' : ''
    if (!list.children.length) message.textContent = 'No questions waiting. New questions from your patients appear here first.'
  }
  async function load() {
    if (typingIn(list)) return
    try {
      const { questions } = await api('GET', '/coach/questions')
      list.replaceChildren(...questions.map(question => questionItem(question, { player, asCoach:true, showPatient:true,
        onAnswered:answered => { count(); onAnswered(answered) } })))
      message.textContent = questions.length >= 200 ? 'Showing the 200 oldest. Answer these to see more.' : ''
      count()
    } catch (error) {
      message.className = 'form-message'
      message.dataset.state = 'error'
      message.textContent = error.message
    }
  }
  load()
  return { element, load }
}

// One patient's questions to this coach, on the patient's page.
export function questionsPanel(patientId, { onAnswered = () => {} } = {}) {
  const list = pagedQuestions(`/patients/${patientId}/questions`, { asCoach:true, onAnswered }, 'This patient has not asked anything yet.')
  list.load()
  return { element:h('section', { className:'panel' }, h('h2', {}, 'Questions'), list.element), load:list.load }
}

export const questionReasonText = reason => `${plural(reason.count, 'question')} waiting since ${when(reason.since)}`
