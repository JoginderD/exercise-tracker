import { api, fetchBlob } from './api.js'
import { h, plural, when, withPending } from './dom.js'

const MAX_TEXT = 2000
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

// One shared player per list, so only one recording plays at a time. Questions are
// recorded on video; the audio element is for early questions recorded as sound only.
function mediaPlayer() {
  const video = h('video', { controls:true, playsinline:true, hidden:true, className:'question-video' })
  const audio = h('audio', { controls:true, hidden:true, className:'question-audio' })
  let url = null
  return {
    element:h('div', {}, video, audio),
    async play(question) {
      const blob = await fetchBlob(`/questions/${question.id}/recording`)
      if (url) URL.revokeObjectURL(url)
      url = URL.createObjectURL(blob)
      const [shown, other] = question.recording.type.startsWith('video/') ? [video, audio] : [audio, video]
      other.pause()
      other.hidden = true
      shown.src = url
      shown.hidden = false
      shown.play().catch(() => {})
      shown.scrollIntoView({ block:'nearest' })
    },
  }
}

// A question with its reply. asCoach adds a reply form while it is unanswered.
function questionItem(question, { player, asCoach = false, showPatient = false, onAnswered = () => {} }) {
  const message = h('p', { className:'form-message', role:'status' })
  const who = asCoach
    ? showPatient ? h('a', { href:`#patients/${question.patientId}` }, question.patientName) : null
    : `To ${question.coachName}`
  // awaiting-you: an open question is the coach's move, so the coach sees it as urgent.
  const item = h('li', { className:asCoach ? 'question awaiting-you' : 'question', 'data-state':question.answeredAt ? 'answered' : 'open' })

  function body() {
    const media = question.recording
    const listen = media ? h('button', { type:'button', className:'secondary' },
      `${media.type.startsWith('video/') ? 'Watch video' : 'Play recording'} (${clock(media.durationMs)})`) : null
    listen?.addEventListener('click', () => withPending(listen, 'Loading…', message, () => player.play(question)))
    const reply = question.answeredAt
      ? h('div', { className:'question-answer' }, h('p', { className:'hint' }, `${asCoach ? 'You' : question.coachName} replied ${when(question.answeredAt)}`),
        h('p', {}, question.answer))
      : asCoach ? replyForm() : h('p', { className:'hint' }, 'Waiting for a reply.')
    item.dataset.state = question.answeredAt ? 'answered' : 'open'
    // replaceChildren, unlike h(), would print a null child as the text "null".
    item.replaceChildren(...[
      h('p', { className:'question-meta' }, who, who ? ' · ' : null, when(question.createdAt),
        question.answeredAt ? null : h('span', { className:'priority-badge' }, asCoach ? 'High priority' : 'Sent')),
      // A recorded question's text is its automatic transcript, checked by the patient before sending.
      question.text && media ? h('p', { className:'question-transcript' }, h('span', { className:'hint' }, 'Transcript: '), question.text) : null,
      question.text && !media ? h('p', { className:'question-text' }, question.text) : null,
      !question.text ? h('p', { className:'hint' }, media ? 'Video question (no transcript)' : 'Question') : null,
      listen, reply, message,
    ].filter(child => child !== null))
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
  const player = mediaPlayer()
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

// The patient's questions and their coaches' replies. Asking happens on the tracker
// (src/ask-widget.js), over the camera picture.
export function patientQuestions() {
  const history = pagedQuestions('/questions', {}, 'No questions yet. Use "Ask your coach" on the camera picture to send one.')
  history.load()
  return {
    element:h('section', { className:'panel' }, h('h2', {}, 'Questions to your coach'),
      h('p', { className:'hint' }, 'Ask from the tracker: type in the "Ask your coach" box on the camera picture, or record a video question. Replies show here.'),
      history.element),
    load:history.load,
  }
}

// The coach's inbox: every unanswered question, oldest first, on the patients page.
export function coachInbox({ onAnswered = () => {} } = {}) {
  const player = mediaPlayer()
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
