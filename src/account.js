import { api, createOutbox } from './api.js'
import { exercises } from './exercises.js'
import { sessionTotal } from './session-record.js'

// Builds DOM nodes. Text children are set as text, never parsed as HTML, so
// names and emails typed by other users cannot inject markup.
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (name.startsWith('on')) element.addEventListener(name.slice(2), value)
    else if (name === 'className') element.className = value
    else element.setAttribute(name, value === true ? '' : value)
  }
  element.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false))
  return element
}

const exerciseName = id => exercises.find(exercise => exercise.id === id)?.name ?? id
const when = ms => new Date(ms).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' })
const duration = ms => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`
const secondsText = ms => Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '—'
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

// Runs an async action with the button disabled and a pending label, then shows the outcome.
async function withPending(button, pendingText, message, action) {
  const label = button.textContent
  button.disabled = true
  button.textContent = pendingText
  message.textContent = ''
  message.dataset.state = ''
  try {
    return await action()
  } catch (error) {
    message.dataset.state = 'error'
    message.textContent = error.message
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

function repLine(rep) {
  if (rep.kind === 'partial') {
    return `Partial (not counted)${Number.isFinite(rep.reached) ? `: reached ${rep.reached}°` : ''}${rep.messages[0] ? ` — ${rep.messages[0]}` : ''}`
  }
  const parts = [`Rep ${rep.number}`]
  if (rep.liftMs !== null || rep.lowerMs !== null) parts.push(`lift ${secondsText(rep.liftMs)} · lower ${secondsText(rep.lowerMs)}`)
  if (rep.tempo) parts.push(rep.tempo === 'good' ? 'good tempo' : `too ${rep.tempo}`)
  if (rep.flagged) parts.push('form flagged')
  return parts.join(' — ')
}

function sessionDetail(session) {
  const sideLabel = lane => lane.side === 'auto' ? 'Auto side' : `${lane.side[0].toUpperCase()}${lane.side.slice(1)} side`
  return h('div', { className:'session-detail' },
    h('p', { className:'hint' }, `${session.source === 'video' ? 'Analysed from a recorded video' : 'Live camera'} · ` +
      `${session.angles === '3d' ? '3D' : '2D'} angles · ended ${when(session.endedAt)}`),
    session.lanes.map(lane => h('div', {},
      session.lanes.length > 1 || lane.side !== 'auto' ? h('h4', {}, `${sideLabel(lane)}: ${plural(lane.reps, 'rep')}`) : null,
      lane.history.length
        ? h('ol', { className:'rep-log' }, lane.history.map(rep => h('li', { 'data-state':rep.kind === 'partial' || rep.tempo === 'fast' || rep.tempo === 'slow' || rep.flagged ? 'warning' : 'within' }, repLine(rep))))
        : h('p', { className:'hint' }, 'No reps on this side.'),
    )),
  )
}

// A paged, newest-first table of sessions with expandable per-rep detail.
function sessionList(loadPage) {
  const body = h('tbody')
  const message = h('p', { className:'form-message', role:'status' })
  const more = h('button', { type:'button', className:'secondary', hidden:true }, 'Load more')
  const table = h('div', { className:'table-wrap' }, h('table', { className:'data-table' },
    h('thead', {}, h('tr', {}, ['Date', 'Exercise', 'Length', 'Reps', 'Flagged', 'Partial', 'Too fast', 'Too slow', ''].map(text => h('th', { scope:'col' }, text)))),
    body,
  ))
  let cursor = null
  const details = new Map()

  function addRow(session) {
    const detailRow = h('tr', { className:'detail-row', hidden:true }, h('td', { colspan:9 }))
    const toggle = h('button', { type:'button', className:'link-button', 'aria-expanded':'false' }, 'Details')
    toggle.addEventListener('click', async () => {
      const open = toggle.getAttribute('aria-expanded') === 'true'
      toggle.setAttribute('aria-expanded', String(!open))
      detailRow.hidden = open
      if (open || details.has(session.id)) return
      const cell = detailRow.firstChild
      cell.replaceChildren(h('p', { className:'hint' }, 'Loading reps…'))
      try {
        const { session:full } = await api('GET', `/sessions/${session.id}`)
        details.set(session.id, full)
        cell.replaceChildren(sessionDetail(full))
      } catch (error) {
        cell.replaceChildren(h('p', { className:'form-message', 'data-state':'error' }, error.message))
      }
    })
    body.append(
      h('tr', {},
        h('td', {}, when(session.startedAt)),
        h('td', {}, exerciseName(session.exercise)),
        h('td', {}, duration(session.endedAt - session.startedAt)),
        h('td', { className:'number' }, session.reps),
        h('td', { className:'number' }, session.flaggedReps),
        h('td', { className:'number' }, session.partialReps),
        h('td', { className:'number' }, session.fastReps),
        h('td', { className:'number' }, session.slowReps),
        h('td', {}, toggle),
      ),
      detailRow,
    )
  }

  async function load() {
    more.disabled = true
    message.dataset.state = ''
    message.textContent = cursor || body.children.length ? 'Loading more…' : 'Loading sessions…'
    try {
      const page = await loadPage(cursor)
      page.sessions.forEach(addRow)
      cursor = page.next
      more.hidden = !cursor
      table.hidden = !body.children.length
      message.textContent = body.children.length ? '' : 'No sessions yet. Finished exercise runs appear here automatically.'
    } catch (error) {
      message.dataset.state = 'error'
      message.textContent = `${error.message} `
      message.append(h('button', { type:'button', className:'link-button', onclick:load }, 'Try again'))
      more.hidden = true
    } finally {
      more.disabled = false
    }
  }
  more.addEventListener('click', load)
  table.hidden = true
  load()
  return h('div', {}, table, message, more)
}

export function createAccount({ bar, view, trackerView, saveStatus, onLeaveTracker }) {
  let user
  let accountState = 'loading'
  let sharedWith = []
  let undo = null
  let refreshTimer

  const setSaveStatus = (text, state = '') => {
    saveStatus.textContent = text
    saveStatus.dataset.state = state
  }
  const outbox = createOutbox(event => {
    const waiting = user ? outbox.pending(user.id) : 0
    const what = `${exerciseName(event.record.exercise)}, ${plural(sessionTotal(event.record), 'rep')}`
    if (event.type === 'queued') setSaveStatus(`Saving session (${what})…`, 'pending')
    else if (event.type === 'saved') {
      setSaveStatus(`Saved: ${what}.${sharedWith.length ? ` Shared with ${sharedWith.map(coach => coach.name).join(', ')}.` : ''}` +
        (waiting ? ` ${plural(waiting, 'session')} still uploading.` : ''), 'within')
    } else if (event.type === 'rejected') setSaveStatus(`Could not save ${what}: ${event.error.message}`, 'warning')
    else setSaveStatus(`Not uploaded yet (${event.error.message}). ${plural(waiting, 'session')} will retry automatically.`, 'warning')
  })

  const route = () => location.hash.replace(/^#\/?/, '')
  const go = hash => { if (route() !== hash.replace(/^#\/?/, '')) location.hash = hash; else render() }

  function renderBar() {
    const current = route()
    const link = (hash, text) => h('a', { href:hash, className:'nav-link', 'aria-current':current === hash.slice(1) || (hash === '#' && !current) ? 'page' : null }, text)
    const signOut = h('button', { type:'button', className:'secondary' }, 'Sign out')
    signOut.addEventListener('click', async () => {
      signOut.disabled = true
      try { await api('POST', '/logout', {}) } catch {}
      const waiting = outbox.pending(user.id)
      user = null
      sharedWith = []
      setSaveStatus(waiting ? `Signed out. ${plural(waiting, 'unsent session')} will upload next time you sign in on this device.` : 'Signed out.')
      go('#')
    })
    let who
    let links
    if (accountState === 'loading') {
      who = 'Checking account…'
      links = []
    } else if (accountState === 'offline') {
      who = 'Account server unavailable: tracking still works, but sessions are not saved.'
      links = [h('button', { type:'button', className:'secondary', onclick:loadUser }, 'Retry')]
    } else if (!user) {
      who = 'Not signed in: sessions are not saved.'
      links = [link('#', 'Tracker'), link('#signin', 'Sign in'), link('#signup', 'Create account')]
    } else {
      who = `${user.name} · ${user.role === 'coach' ? 'Coach' : 'Patient'}`
      links = user.role === 'coach'
        ? [link('#patients', 'Patients'), link('#', 'Tracker'), signOut]
        : [link('#', 'Tracker'), link('#sessions', 'My sessions'), signOut]
    }
    bar.replaceChildren(h('span', { className:'account-who' }, who), h('span', { className:'account-links' }, links))
  }

  function authView(mode) {
    const signup = mode === 'signup'
    const message = h('p', { className:'form-message', role:'alert' })
    const submit = h('button', { type:'submit' }, signup ? 'Create account' : 'Sign in')
    const form = h('form', { className:'panel auth-form', novalidate:true },
      h('h2', {}, signup ? 'Create an account' : 'Sign in'),
      signup ? h('fieldset', { className:'role-choice' },
        h('legend', {}, 'I am a'),
        h('label', {}, h('input', { type:'radio', name:'role', value:'patient', checked:true }), ' Patient doing exercises'),
        h('label', {}, h('input', { type:'radio', name:'role', value:'coach' }), ' Treatment coach'),
      ) : null,
      signup ? h('label', {}, 'Name', h('input', { name:'name', autocomplete:'name', required:true, maxlength:100 })) : null,
      h('label', {}, 'Email', h('input', { name:'email', type:'email', autocomplete:'email', required:true })),
      h('label', {}, 'Password', h('input', { name:'password', type:'password', required:true, minlength:signup ? 10 : null,
        autocomplete:signup ? 'new-password' : 'current-password' })),
      signup ? h('p', { className:'hint' }, 'At least 10 characters.') : null,
      submit,
      message,
      h('p', { className:'hint' }, signup
        ? h('span', {}, 'Already have an account? ', h('a', { href:'#signin' }, 'Sign in'))
        : h('span', {}, 'New here? ', h('a', { href:'#signup' }, 'Create an account'))),
    )
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (submit.disabled) return
      const data = Object.fromEntries(new FormData(form))
      withPending(submit, signup ? 'Creating account…' : 'Signing in…', message, async () => {
        const result = await api('POST', signup ? '/signup' : '/login', data)
        await signedIn(result.user)
        go(user.role === 'coach' ? '#patients' : '#')
      })
    })
    return form
  }

  function sharingPanel() {
    const list = h('ul', { className:'item-list' })
    const message = h('p', { className:'form-message', role:'status' })
    const input = h('input', { name:'code', placeholder:'ABCDE-12345', autocomplete:'off', autocapitalize:'characters', 'aria-label':'Coach code', maxlength:20 })
    const submit = h('button', { type:'submit' }, 'Share with coach')

    function showCoaches(coaches) {
      sharedWith = coaches
      list.replaceChildren(...coaches.length
        ? coaches.map(coach => {
          const stop = h('button', { type:'button', className:'secondary' }, 'Stop sharing')
          stop.addEventListener('click', () => withPending(stop, 'Stopping…', message, async () => {
            const result = await api('DELETE', `/coaches/${coach.id}`)
            showCoaches(result.coaches)
            showUndo(coach, result.undo)
          }))
          return h('li', {}, h('span', {}, h('strong', {}, coach.name), ` (${coach.email}) · since ${when(coach.linkedAt)}`), stop)
        })
        : [h('li', { className:'hint' }, 'Not shared with any coach yet.')])
    }
    function showUndo(coach, token) {
      clearTimeout(undo?.timer)
      if (!token) return
      const button = h('button', { type:'button', className:'link-button' }, 'Undo')
      message.dataset.state = 'within'
      message.replaceChildren(`${coach.name} can no longer see your sessions. `, button)
      button.addEventListener('click', () => withPending(button, 'Restoring…', message, async () => {
        const result = await api('POST', '/coaches/restore', { token })
        showCoaches(result.coaches)
        message.dataset.state = 'within'
        message.textContent = `Sharing with ${coach.name} again.`
      }))
      undo = { timer:setTimeout(() => { if (message.contains(button)) message.textContent = '' }, 110 * 1000) }
    }

    const form = h('form', { className:'inline-form' }, input, submit)
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (!input.value.trim()) { message.dataset.state = 'error'; message.textContent = 'Enter the code your coach gave you.'; return }
      withPending(submit, 'Sharing…', message, async () => {
        const result = await api('POST', '/coaches', { code:input.value })
        showCoaches(result.coaches)
        input.value = ''
        message.dataset.state = 'within'
        message.textContent = `${result.coach.name} can now see all your saved sessions, past and future.`
      })
    })

    list.append(h('li', { className:'hint' }, 'Loading…'))
    api('GET', '/coaches').then(result => showCoaches(result.coaches)).catch(error => {
      list.replaceChildren(h('li', { className:'form-message', 'data-state':'error' }, error.message))
    })
    return h('section', { className:'panel' },
      h('h2', {}, 'Share with your treatment coach'),
      h('p', { className:'hint' }, 'Enter the code from your coach. They will see every session you save, including earlier ones, until you stop sharing.'),
      list, form, message,
    )
  }

  function patientView() {
    const waiting = outbox.pending(user.id)
    const retry = h('button', { type:'button', className:'link-button' }, 'Upload now')
    retry.addEventListener('click', () => outbox.flush(user.id).then(render))
    return h('div', {},
      sharingPanel(),
      h('section', { className:'panel' },
        h('div', { className:'panel-header' },
          h('h2', {}, 'My sessions'),
          h('a', { href:'/api/sessions.csv', className:'nav-link', download:true }, 'Download CSV'),
        ),
        waiting ? h('p', { className:'form-message', 'data-state':'warning' }, `${plural(waiting, 'session')} waiting to upload. `, retry) : null,
        sessionList(cursor => api('GET', `/sessions?limit=25${cursor ? `&before=${cursor}` : ''}`)),
      ),
    )
  }

  function coachCodePanel() {
    const message = h('p', { className:'form-message', role:'status' })
    const code = h('p', { className:'coach-code' }, user.coachCode)
    const copy = h('button', { type:'button', className:'secondary' }, 'Copy code')
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(user.coachCode)
        message.dataset.state = 'within'
        message.textContent = 'Code copied.'
      } catch {
        message.dataset.state = 'warning'
        message.textContent = 'Could not copy automatically; select the code and copy it.'
      }
    })
    const rotate = h('button', { type:'button', className:'secondary' }, 'Get a new code')
    rotate.addEventListener('click', () => {
      if (!confirm('Get a new code? The current code stops working for new patients. Patients already sharing with you are not affected.')) return
      withPending(rotate, 'Generating…', message, async () => {
        user = (await api('POST', '/coach-code')).user
        code.textContent = user.coachCode
        message.dataset.state = 'within'
        message.textContent = 'New code ready. The old one no longer works.'
      })
    })
    return h('section', { className:'panel' },
      h('h2', {}, 'Your coach code'),
      h('p', { className:'hint' }, 'Give this code to your patients. They enter it under My sessions to share their exercise data with you.'),
      code, h('div', {}, copy, rotate), message,
    )
  }

  function rosterPanel() {
    const content = h('div', {}, h('p', { className:'hint' }, 'Loading patients…'))
    const refresh = h('button', { type:'button', className:'secondary' }, 'Refresh')
    async function load() {
      refresh.disabled = true
      try {
        const { patients } = await api('GET', '/patients')
        content.replaceChildren(patients.length
          ? h('div', { className:'table-wrap' }, h('table', { className:'data-table' },
            h('thead', {}, h('tr', {}, ['Patient', 'Email', 'Sessions', 'Total reps', 'Last session'].map(text => h('th', { scope:'col' }, text)))),
            h('tbody', {}, patients.map(patient => h('tr', {},
              h('td', {}, h('a', { href:`#patients/${patient.id}` }, patient.name)),
              h('td', {}, patient.email),
              h('td', { className:'number' }, patient.sessionCount),
              h('td', { className:'number' }, patient.totalReps),
              h('td', {}, patient.lastSessionAt ? when(patient.lastSessionAt) : 'None yet'),
            ))),
          ))
          : h('p', { className:'hint' }, 'No patients are sharing with you yet. Give them your coach code.'))
      } catch (error) {
        content.replaceChildren(h('p', { className:'form-message', 'data-state':'error' }, error.message))
      } finally {
        refresh.disabled = false
      }
    }
    refresh.addEventListener('click', load)
    load()
    // New sessions show up without a manual reload while the dashboard is open.
    refreshTimer = setInterval(() => { if (!document.hidden) load() }, 60 * 1000)
    return h('section', { className:'panel' }, h('div', { className:'panel-header' }, h('h2', {}, 'Patients'), refresh), content)
  }

  function patientDetailView(id) {
    const heading = h('h2', {}, 'Patient')
    const sub = h('p', { className:'hint' })
    const list = sessionList(async cursor => {
      const page = await api('GET', `/patients/${id}/sessions?limit=25${cursor ? `&before=${cursor}` : ''}`)
      heading.textContent = page.patient.name
      sub.textContent = page.patient.email
      return page
    })
    return h('section', { className:'panel' },
      h('p', {}, h('a', { href:'#patients' }, 'All patients')),
      h('div', { className:'panel-header' }, heading,
        h('a', { href:`/api/patients/${id}/sessions.csv`, className:'nav-link', download:true }, 'Download CSV')),
      sub, list,
    )
  }

  function render() {
    clearInterval(refreshTimer)
    renderBar()
    const current = route()
    let content = null
    if (current === 'signin' || current === 'signup') {
      content = user ? null : authView(current)
    } else if (current === 'sessions' && user?.role === 'patient') {
      content = patientView()
    } else if (current === 'patients' && user?.role === 'coach') {
      content = h('div', {}, coachCodePanel(), rosterPanel())
    } else if (/^patients\/\d+$/.test(current) && user?.role === 'coach') {
      content = patientDetailView(current.split('/')[1])
    } else if (current && accountState === 'ready') {
      // Unknown or not-allowed route: back to the tracker.
      return go('#')
    }
    if (content && !trackerView.hidden) onLeaveTracker()
    trackerView.hidden = Boolean(content)
    view.hidden = !content
    view.replaceChildren(...content ? [content] : [])
  }

  async function signedIn(next) {
    user = next
    accountState = 'ready'
    if (user?.role === 'patient') {
      sharedWith = await api('GET', '/coaches').then(result => result.coaches, () => [])
      outbox.flush(user.id)
    }
  }

  async function loadUser() {
    accountState = 'loading'
    renderBar()
    try {
      await signedIn((await api('GET', '/me')).user)
    } catch {
      accountState = 'offline'
    }
    render()
  }

  window.addEventListener('hashchange', render)
  window.addEventListener('online', () => user && outbox.flush(user.id))
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !user) return
    outbox.flush(user.id)
    // Coaches see sessions their patients finished while this tab was in the background.
    if (user.role === 'coach' && route().startsWith('patients')) render()
  })
  loadUser()

  return {
    // Called by the tracker when a run with at least one rep attempt ends.
    saveSession(record, { leaving = false } = {}) {
      if (!record) return
      if (!user) {
        setSaveStatus(`Not saved: ${plural(sessionTotal(record), 'rep')} of ${exerciseName(record.exercise)}. Sign in to keep your sessions and share them with your coach.`, 'warning')
        return
      }
      if (user.role !== 'patient') {
        setSaveStatus('Coach accounts do not save sessions; sign in as a patient to record them.')
        return
      }
      outbox.add(user.id, record)
      // keepalive lets the upload finish after the page is closed.
      outbox.flush(user.id, { keepalive:leaving })
    },
  }
}
