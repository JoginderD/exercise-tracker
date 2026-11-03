import { api, createClipUploader, createOutbox, fetchBlob } from './api.js'
import { progressCharts } from './progress.js'
import { exercises } from './exercises.js'
import { SAFETY_LABELS } from './safety.js'
import { sessionTotal } from './session-record.js'
import { h, plural, when, withPending } from './dom.js'
import { coachInbox, patientQuestions, questionReasonText, questionsPanel } from './questions-panel.js'
import { patientCalendar, patientPlans, planEditor } from './plan-panel.js'

const exerciseName = id => exercises.find(exercise => exercise.id === id)?.name ?? id
const duration = ms => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`
const secondsText = ms => Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '—'
// "8 reps", "8 reps, 8 sensor lifts", or "5 sensor lifts" when the camera counted none.
function repsText(record) {
  const reps = sessionTotal(record)
  const lifts = record.imu?.reps.length ?? 0
  if (!lifts) return plural(reps, 'rep')
  return reps ? `${plural(reps, 'rep')}, ${plural(lifts, 'sensor lift')}` : plural(lifts, 'sensor lift')
}

// What the server's Google redirect (#signin?google=…) means for the person.
const GOOGLE_MESSAGES = {
  cancelled:['warning', 'Google sign-in was cancelled.'],
  expired:['error', 'Google sign-in expired or was started in another tab. Try again.'],
  failed:['error', 'Google sign-in did not work. Try again, or use your email and password.'],
  busy:['error', 'Too many sign-in attempts. Wait a few minutes and try again.'],
  'other-account':['error', 'This email is already connected to a different Google account. Continue with that account, or use your password.'],
}
// Google's standard "G" mark, as its sign-in branding guidelines require.
const GOOGLE_MARK = '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>'
function googleButton(text) {
  const link = h('a', { href:'/api/auth/google/start', className:'google-button' }, text)
  link.insertAdjacentHTML('afterbegin', GOOGLE_MARK)
  return link
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

function sensorRepLine(rep, threshold, sets) {
  const parts = [`${sets > 1 ? `Set ${rep.set ?? 1}, rep` : 'Rep'} ${rep.number}`, `${rep.mcv.toFixed(2)} m/s (peak ${rep.peakVelocity.toFixed(2)})`, `${Math.round(rep.romCm)} cm`,
    `lift ${secondsText(rep.concentricMs)} · lower ${secondsText(rep.eccentricMs)}`]
  if (rep.meanPowerW !== null) parts.push(`${Math.round(rep.meanPowerW)} W avg, ${Math.round(rep.peakPowerW)} W peak`)
  if (rep.rotationDeg >= 10) parts.push(`dumbbell turned ${Math.round(rep.rotationDeg)}°`)
  if (rep.number > 1) parts.push(`speed drop ${Math.round(rep.velocityLossPct)}%${rep.velocityLossPct >= threshold ? ' (fatigue)' : ''}`)
  return parts.join(' — ')
}

// What the dumbbell sensor measured, if it was connected for this session.
function sensorDetail(session) {
  const imu = session.imu
  const summary = session.sensor
  if (!imu || !summary) return null
  const sets = Math.max(...imu.reps.map(rep => rep.set ?? 1))
  const facts = [
    `${plural(summary.reps, 'lift')}${sets > 1 ? ` in ${sets} sets` : ''} measured${imu.hand ? ` in the ${imu.hand} hand` : ''}${imu.massKg ? ` with ${imu.massKg} kg` : ''}`,
    `fastest ${summary.bestMcv.toFixed(2)} m/s, average ${summary.meanMcv.toFixed(2)} m/s`,
    `final speed drop ${Math.round(summary.finalLossPct)}%`,
  ]
  if (summary.totalWorkJ !== null) facts.push(`${Math.round(summary.totalWorkJ)} J of work`)
  return h('div', {},
    h('h4', {}, 'Dumbbell sensor'),
    h('p', { className:'hint' }, `${facts.join(' · ')}.` +
      (imu.interruptions ? ` The Bluetooth link dropped data ${plural(imu.interruptions, 'time')}, so some lifts may be missing.` : '') +
      (imu.massKg ? '' : ' No weight was entered, so power is not shown.')),
    h('ol', { className:'rep-log' }, imu.reps.map(rep => h('li', { 'data-state':rep.velocityLossPct >= imu.lossThresholdPct ? 'warning' : 'within' }, sensorRepLine(rep, imu.lossThresholdPct, sets)))),
  )
}

// Safety alerts in the order they happened, so a coach can follow up.
function safetyDetail(session) {
  if (!session.safety?.length) return null
  const time = ms => new Date(ms).toLocaleTimeString(undefined, { timeStyle:'medium' })
  return h('div', {},
    h('h4', {}, 'Safety alerts'),
    h('ol', { className:'rep-log' }, session.safety.map(alert => h('li', { 'data-state':'warning' }, `${time(alert.at)} — ${SAFETY_LABELS[alert.kind] ?? alert.kind}`))),
  )
}

const sideName = side => side === 'auto' ? 'Auto side' : `${side[0].toUpperCase()}${side.slice(1)} side`
const UNDO_MS = 6000

// Short videos around this session's flagged moments, with one shared player.
// owner: the patient viewing their own session, who may delete clips.
function clipsDetail(session, { owner }) {
  const clips = session.clips ?? []
  const player = h('video', { controls:true, playsinline:true, hidden:true, className:'clip-player' })
  const message = h('p', { className:'form-message', role:'status' })
  let url = null
  const labelText = clip => clip.labels.map(label =>
    `${label.lane && session.lanes.length > 1 ? `${sideName(label.lane)}, ` : ''}${label.rep ? `rep ${label.rep}: ` : ''}${label.text}`).join(' · ')

  function play(clip, button) {
    return withPending(button, 'Loading…', message, async () => {
      const blob = await fetchBlob(`/clips/${clip.id}`)
      if (url) URL.revokeObjectURL(url)
      url = URL.createObjectURL(blob)
      player.src = url
      player.hidden = false
      player.play().catch(() => {})
      player.scrollIntoView({ block:'nearest' })
    })
  }

  function remove(clip, item) {
    item.hidden = true
    const undo = h('button', { type:'button', className:'link-button' }, 'Undo')
    message.dataset.state = ''
    message.replaceChildren('Clip deleted. ', undo)
    const timer = setTimeout(async () => {
      try {
        await api('DELETE', `/clips/${clip.id}`)
        if (message.contains(undo)) message.replaceChildren()
      } catch (error) {
        item.hidden = false
        message.dataset.state = 'error'
        message.textContent = `Could not delete the clip: ${error.message}`
      }
    }, UNDO_MS)
    undo.addEventListener('click', () => {
      clearTimeout(timer)
      item.hidden = false
      message.textContent = 'Clip kept.'
    })
  }

  const element = clips.length ? h('div', {},
    h('h4', {}, `Clips of flagged moments (${clips.length})`),
    player,
    h('ul', { className:'item-list clip-list' }, clips.map(clip => {
      const watch = h('button', { type:'button', className:'secondary' }, `Watch (${secondsText(clip.durationMs)})`)
      watch.addEventListener('click', () => play(clip, watch))
      const item = h('li', {}, h('span', {}, `${new Date(clip.startedAt).toLocaleTimeString(undefined, { timeStyle:'medium' })} — ${labelText(clip)}`),
        h('span', { className:'button-row' }, watch, owner ? h('button', { type:'button', className:'secondary', onclick:() => remove(clip, item) }, 'Delete') : null))
      return item
    })),
    message,
  ) : null
  // The clip showing a given rep, for the "Watch clip" link in the rep log.
  const clipFor = (side, number) => clips.find(clip => clip.labels.some(label => label.lane === side && label.rep === number))
  return { element, play, clipFor }
}

function sessionDetail(session, { owner = false } = {}) {
  const clips = clipsDetail(session, { owner })
  const repItem = (lane, rep) => {
    const item = h('li', { 'data-state':rep.kind === 'partial' || rep.tempo === 'fast' || rep.tempo === 'slow' || rep.flagged ? 'warning' : 'within' }, repLine(rep))
    const clip = rep.kind === 'full' && clips.clipFor(lane.side, rep.number)
    if (clip) {
      const watch = h('button', { type:'button', className:'link-button' }, 'Watch clip')
      watch.addEventListener('click', () => clips.play(clip, watch))
      item.append(' ', watch)
    }
    return item
  }
  return h('div', { className:'session-detail' },
    h('p', { className:'hint' }, `${session.source === 'video' ? 'Analysed from a recorded video' : 'Live camera'} · ` +
      `${session.angles === '3d' ? '3D' : '2D'} angles · ended ${when(session.endedAt)}`),
    safetyDetail(session),
    clips.element,
    session.lanes.map(lane => h('div', {},
      session.lanes.length > 1 || lane.side !== 'auto' ? h('h4', {}, `${sideName(lane.side)}: ${plural(lane.reps, 'rep')}`) : null,
      lane.history.length
        ? h('ol', { className:'rep-log' }, lane.history.map(rep => repItem(lane, rep)))
        : h('p', { className:'hint' }, 'No reps on this side.'),
    )),
    sensorDetail(session),
  )
}

// A paged, newest-first table of sessions with expandable per-rep detail.
function sessionList(loadPage, detailOptions = {}) {
  const body = h('tbody')
  const message = h('p', { className:'form-message', role:'status' })
  const more = h('button', { type:'button', className:'secondary', hidden:true }, 'Load more')
  const table = h('div', { className:'table-wrap' }, h('table', { className:'data-table' },
    h('thead', {}, h('tr', {}, ['Date', 'Exercise', 'Length', 'Reps', 'Safety', 'Flagged', 'Partial', 'Too fast', 'Too slow', 'Speed drop', ''].map(text => h('th', { scope:'col' }, text)))),
    body,
  ))
  let cursor = null
  const details = new Map()

  function addRow(session) {
    const detailRow = h('tr', { className:'detail-row', hidden:true }, h('td', { colspan:11 }))
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
        cell.replaceChildren(sessionDetail(full, detailOptions))
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
        h('td', { className:'number', 'data-state':session.safetyAlerts ? 'warning' : null }, session.safetyAlerts),
        h('td', { className:'number' }, session.flaggedReps),
        h('td', { className:'number' }, session.partialReps),
        h('td', { className:'number' }, session.fastReps),
        h('td', { className:'number' }, session.slowReps),
        h('td', { className:'number', title:session.sensor ? `Dumbbell sensor: ${plural(session.sensor.reps, 'lift')}, fastest ${session.sensor.bestMcv.toFixed(2)} m/s` : 'No dumbbell sensor' },
          session.sensor ? `${Math.round(session.sensor.finalLossPct)}%` : '—'),
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

// onCoaches(coaches): the coaches a signed-in patient shares with, whenever that changes
// (empty when signed out or not a patient), for the tracker's "Ask your coach" box.
// For the tracker's plan guide: onUser(user, queued) on every sign-in and sign-out, with the
// sessions still waiting to upload; onOutbox(event) for each session queued, saved or
// refused; onShowTracker() when the tracker comes back into view.
export function createAccount({ bar, view, trackerView, saveStatus, onLeaveTracker, onCoaches = () => {},
  onUser = () => {}, onOutbox = () => {}, onShowTracker = () => {} }) {
  let user
  let accountState = 'loading'
  let sharedWith = []
  const setSharedWith = coaches => { sharedWith = coaches; onCoaches(coaches) }
  let undo = null
  // Panels on the open page register a reload here; it runs every minute while the tab
  // is visible and when it comes back, so new questions, replies and plan edits show up
  // without a manual reload. Reset on each render.
  let liveLoads = []
  let liveTimer
  // Set by an editor holding unsaved changes, so leaving the page asks first.
  let unsaved = () => false
  const live = (...loads) => { liveLoads.push(...loads) }
  let googleEnabled = false

  const setSaveStatus = (text, state = '') => {
    saveStatus.textContent = text
    saveStatus.dataset.state = state
  }
  const outbox = createOutbox(event => {
    const waiting = user ? outbox.pending(user.id) : 0
    const what = `${exerciseName(event.record.exercise)}, ${repsText(event.record)}`
    if (event.type === 'queued') setSaveStatus(`Saving session (${what})…`, 'pending')
    else if (event.type === 'saved') {
      setSaveStatus(`Saved: ${what}.${sharedWith.length ? ` Shared with ${sharedWith.map(coach => coach.name).join(', ')}.` : ''}` +
        (waiting ? ` ${plural(waiting, 'session')} still uploading.` : ''), 'within')
    } else if (event.type === 'rejected') setSaveStatus(`Could not save ${what}: ${event.error.message}`, 'warning')
    else setSaveStatus(`Not uploaded yet (${event.error.message}). ${plural(waiting, 'session')} will retry automatically.`, 'warning')
    // A saved session lets its clips upload.
    if (event.type === 'saved' && user) clipUploader.flush(user.id)
    onOutbox(event)
  })
  const clipUploader = createClipUploader(event => {
    if (event.type === 'sent') setSaveStatus(`Sent ${plural(event.count, 'clip')} of flagged moments to your coach.`, 'within')
    else if (event.type === 'rejected') setSaveStatus(`A clip was not sent: ${event.error.message}`, 'warning')
    else setSaveStatus(`Clips not sent yet (${event.error.message}). They will retry automatically.`, 'warning')
  })
  const flushAll = userId => outbox.flush(userId).then(() => clipUploader.flush(userId))

  // "#signin?google=link" is the route "signin" with the parameter google=link.
  const route = () => location.hash.replace(/^#\/?/, '').split('?')[0]
  const routeParams = () => new URLSearchParams(location.hash.split('?')[1] ?? '')
  const go = hash => { if (route() !== hash.replace(/^#\/?/, '')) location.hash = hash; else render() }

  // Dev account switcher's list, kept across bar re-renders (see devSwitcher).
  let devUsers = null

  function renderBar() {
    const current = route()
    const link = (hash, text) => h('a', { href:hash, className:'nav-link', 'aria-current':current === hash.slice(1) || (hash === '#' && !current) ? 'page' : null }, text)
    const signOut = h('button', { type:'button', className:'secondary' }, 'Sign out')
    signOut.addEventListener('click', async () => {
      signOut.disabled = true
      try { await api('POST', '/logout', {}) } catch {}
      const waiting = outbox.pending(user.id)
      user = null
      setSharedWith([])
      onUser(null, [])
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
        : [link('#', 'Tracker'), link('#plan', 'My plan'), link('#sessions', 'My sessions'), signOut]
    }
    if (import.meta.env.DEV && accountState === 'ready') links.push(devSwitcher())
    bar.replaceChildren(h('span', { className:'account-who' }, who), h('span', { className:'account-links' }, links))
  }

  // Temporary, development builds only: jump between test accounts without a password.
  // The list loads when the bar renders, not when the menu opens: a native menu opened
  // before its options arrive shows only the placeholder, so the first click did nothing.
  // It reloads on every bar render, so newly created accounts show up after navigating.
  function devSwitcher() {
    const placeholder = h('option', { value:'' }, devUsers ? 'Switch account (dev)…' : 'Loading accounts…')
    const select = h('select', { className:'dev-switch', 'aria-label':'Switch account (development only)', disabled:!devUsers }, placeholder)
    const fill = () => {
      if (!devUsers) return
      placeholder.textContent = 'Switch account (dev)…'
      select.disabled = false
      select.replaceChildren(placeholder, ...devUsers.map(other => h('option', { value:other.id, disabled:other.id === user?.id },
        `${other.name} · ${other.role === 'coach' ? 'Coach' : 'Patient'} · ${other.email}`)))
    }
    fill()
    api('GET', '/dev/users').then(({ users }) => {
      devUsers = users
      // Replacing options under an open menu leaves it stale, so wait until it closes.
      if (document.activeElement === select) select.addEventListener('blur', fill, { once:true })
      else fill()
    }, error => {
      if (devUsers) return
      placeholder.textContent = 'Accounts unavailable'
      setSaveStatus(`Could not list accounts: ${error.message}`, 'warning')
    })
    select.addEventListener('change', async () => {
      const userId = Number(select.value)
      if (!userId) return
      select.disabled = true
      setSaveStatus('Switching account…', 'pending')
      try {
        // Stopping the tracker saves its run; that upload must finish while this
        // browser is still signed in as the account that did the run.
        if (!trackerView.hidden) onLeaveTracker()
        if (user) await outbox.flush(user.id)
        const result = await api('POST', '/dev/switch', { userId })
        setSharedWith([])
        await signedIn(result.user)
        setSaveStatus(`Switched to ${user.name} (${user.role}).`, 'within')
        go(user.role === 'coach' ? '#patients' : '#')
      } catch (error) {
        setSaveStatus(`Could not switch account: ${error.message}`, 'warning')
        renderBar()
      }
    })
    return select
  }

  function authView(mode) {
    const signup = mode === 'signup'
    const message = h('p', { className:'form-message', role:'alert' })
    const googleState = routeParams().get('google')
    const linking = !signup && googleState === 'link'
    const submit = h('button', { type:'submit' }, signup ? 'Create account' : linking ? 'Connect and sign in' : 'Sign in')
    const email = h('input', { name:'email', type:'email', autocomplete:'email', required:true })
    if (GOOGLE_MESSAGES[googleState]) [message.dataset.state, message.textContent] = GOOGLE_MESSAGES[googleState]
    // Google confirmed this email, but an account with it already has a password: one
    // password sign-in joins them, after which either way of signing in works.
    const notice = linking ? h('p', { className:'auth-notice', role:'status' }, 'Checking your Google sign-in…') : null
    if (linking) {
      api('GET', '/auth/google/pending').then(({ pending }) => {
        if (pending?.kind !== 'link') {
          notice.textContent = 'Google sign-in expired. Continue with Google again, or sign in with your password.'
          return
        }
        email.value = pending.email
        notice.textContent = `An account with ${pending.email} already exists. Enter its password once to connect your Google account; after that you can use either.`
        form.elements.password.focus()
      }, error => { notice.textContent = error.message })
    }
    const form = h('form', { className:'panel auth-form', novalidate:true },
      h('h2', {}, linking ? 'Connect Google' : signup ? 'Create an account' : 'Sign in'),
      notice,
      googleEnabled && !linking ? [googleButton(signup ? 'Sign up with Google' : 'Sign in with Google'), h('p', { className:'auth-divider' }, 'or')] : null,
      signup ? h('fieldset', { className:'role-choice' },
        h('legend', {}, 'I am a'),
        h('label', {}, h('input', { type:'radio', name:'role', value:'patient', checked:true }), ' Patient doing exercises'),
        h('label', {}, h('input', { type:'radio', name:'role', value:'coach' }), ' Treatment coach'),
      ) : null,
      signup ? h('label', {}, 'Name', h('input', { name:'name', autocomplete:'name', required:true, maxlength:100 })) : null,
      h('label', {}, 'Email', email),
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
        if (result.linkedGoogle) setSaveStatus('Google account connected. You can now sign in with Google too.', 'within')
        else if (linking) setSaveStatus('Signed in, but Google could not be connected (the sign-in expired). Try Sign in with Google again.', 'warning')
        go(user.role === 'coach' ? '#patients' : '#')
      })
    })
    return form
  }

  // After Google, a new person only picks their role; the name starts as their Google name.
  function googleSignupView() {
    const message = h('p', { className:'form-message', role:'alert' })
    const submit = h('button', { type:'submit', disabled:true }, 'Create account')
    const name = h('input', { name:'name', autocomplete:'name', required:true, maxlength:100 })
    const intro = h('p', { className:'hint' }, 'Loading your Google details…')
    const form = h('form', { className:'panel auth-form', novalidate:true },
      h('h2', {}, 'Finish signing up'),
      intro,
      h('fieldset', { className:'role-choice' },
        h('legend', {}, 'I am a'),
        h('label', {}, h('input', { type:'radio', name:'role', value:'patient', checked:true }), ' Patient doing exercises'),
        h('label', {}, h('input', { type:'radio', name:'role', value:'coach' }), ' Treatment coach'),
      ),
      h('label', {}, 'Name', name),
      submit,
      message,
      h('p', { className:'hint' }, h('span', {}, 'Wrong account? ', h('a', { href:'/api/auth/google/start' }, 'Use a different Google account'))),
    )
    api('GET', '/auth/google/pending').then(({ pending }) => {
      if (pending?.kind !== 'signup') {
        intro.textContent = 'This Google sign-in has expired.'
        intro.append(' ', googleEnabled ? h('a', { href:'/api/auth/google/start' }, 'Continue with Google again') : h('a', { href:'#signin' }, 'Sign in'))
        return
      }
      intro.textContent = `Signed in with Google as ${pending.email}. Choose how you will use Exercise Tracker.`
      name.value = pending.name
      submit.disabled = false
    }, error => {
      intro.textContent = ''
      message.dataset.state = 'error'
      message.textContent = error.message
    })
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (submit.disabled) return
      const data = Object.fromEntries(new FormData(form))
      withPending(submit, 'Creating account…', message, async () => {
        const result = await api('POST', '/auth/google/complete', data)
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
      setSharedWith(coaches)
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

    // Opt-in, off by default: video of the patient leaves the device only with this on.
    const clipToggle = h('input', { type:'checkbox', checked:user.shareClips })
    const clipMessage = h('p', { className:'form-message', role:'status' })
    clipToggle.addEventListener('change', async () => {
      const on = clipToggle.checked
      clipToggle.disabled = true
      clipMessage.dataset.state = ''
      clipMessage.textContent = on ? 'Turning on…' : 'Turning off…'
      try {
        user = (await api('PUT', '/me/share-clips', { on })).user
        clipMessage.dataset.state = 'within'
        clipMessage.textContent = on
          ? 'On. From your next session, a few seconds of video around each flagged moment will be sent to your coach.'
          : 'Off. No more clips will be sent, and your coach can no longer watch the ones already sent. You can still see them.'
      } catch (error) {
        clipToggle.checked = !on
        clipMessage.dataset.state = 'error'
        clipMessage.textContent = error.message
      } finally {
        clipToggle.disabled = false
      }
    })
    return h('section', { className:'panel' },
      h('h2', {}, 'Share with your treatment coach'),
      h('p', { className:'hint' }, 'Enter the code from your coach. They will see every session you save, including earlier ones, until you stop sharing.'),
      list, form, message,
      h('label', { className:'switch' }, clipToggle, ' Send short clips of flagged moments to my coach'),
      h('p', { className:'hint' }, 'About 6 seconds of video around each form warning, safety alert or tempo problem, with the tracking lines drawn on. ' +
        'Nothing else is uploaded; full recordings stay on this device. You can delete any clip from your sessions below.'),
      clipMessage,
    )
  }

  function patientView() {
    const waiting = outbox.pending(user.id)
    const retry = h('button', { type:'button', className:'link-button' }, 'Upload now')
    retry.addEventListener('click', () => outbox.flush(user.id).then(render))
    const questions = patientQuestions()
    live(questions.load)
    return h('div', {},
      questions.element,
      sharingPanel(),
      h('section', { className:'panel' },
        h('div', { className:'panel-header' },
          h('h2', {}, 'My sessions'),
          h('a', { href:'/api/sessions.csv', className:'nav-link', download:true }, 'Download CSV'),
        ),
        waiting ? h('p', { className:'form-message', 'data-state':'warning' }, `${plural(waiting, 'session')} waiting to upload. `, retry) : null,
        sessionList(cursor => api('GET', `/sessions?limit=25${cursor ? `&before=${cursor}` : ''}`), { owner:true }),
      ),
      progressPanel('/progress'),
    )
  }

  function progressPanel(path) {
    const content = h('div', {}, h('p', { className:'hint' }, 'Loading progress…'))
    api('GET', path).then(({ sessions }) => content.replaceChildren(progressCharts(sessions, h)),
      error => content.replaceChildren(h('p', { className:'form-message', 'data-state':'error' }, error.message)))
    return h('section', { className:'panel' }, h('h2', {}, 'Progress, last 12 weeks'), content)
  }

  // Why a patient needs a look (server/attention.js), worded for the coach.
  function attentionText(reason) {
    if (reason.kind === 'question') return questionReasonText(reason)
    if (reason.kind === 'safety') return `Safety alert ${when(reason.at)}${reason.sessions > 1 ? ` (${reason.sessions} sessions this week)` : ''}`
    if (reason.kind === 'flagged') return reason.from === null ? `${reason.to}% of reps flagged this week` : `Flagged reps up from ${reason.from}% to ${reason.to}%`
    return reason.never ? `No session yet (linked ${plural(reason.days, 'day')} ago)` : `No session for ${plural(reason.days, 'day')}`
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
            h('thead', {}, h('tr', {}, ['Patient', 'Needs a look', 'Email', 'Sessions', 'Total reps', 'Safety alerts', 'Last session'].map(text => h('th', { scope:'col' }, text)))),
            h('tbody', {}, patients.map(patient => h('tr', {},
              h('td', {}, h('a', { href:`#patients/${patient.id}` }, patient.name)),
              h('td', { 'data-state':patient.attention.length ? 'warning' : null },
                patient.attention.length ? h('ul', { className:'attention-list' }, patient.attention.map(reason => h('li', { className:reason.priority === 'high' ? 'priority-high' : null }, attentionText(reason)))) : '—'),
              h('td', {}, patient.email),
              h('td', { className:'number' }, patient.sessionCount),
              h('td', { className:'number' }, patient.totalReps),
              h('td', { className:'number', 'data-state':patient.safetySessions ? 'warning' : null,
                title:'Sessions with at least one safety alert' }, patient.safetySessions ? plural(patient.safetySessions, 'session') : 'None'),
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
    live(load)
    return { element:h('section', { className:'panel' }, h('div', { className:'panel-header' }, h('h2', {}, 'Patients'), refresh), content), load }
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
    const calendar = patientCalendar(id)
    const plan = planEditor(id, { onSaved:calendar.load })
    const questions = questionsPanel(id)
    live(plan.load, questions.load, calendar.load)
    unsaved = plan.dirty
    return h('div', {},
      h('section', { className:'panel' },
        h('p', {}, h('a', { href:'#patients' }, 'All patients')),
        h('div', { className:'panel-header' }, heading,
          h('a', { href:`/api/patients/${id}/sessions.csv`, className:'nav-link', download:true }, 'Download CSV')),
        sub, list,
      ),
      questions.element,
      plan.element,
      calendar.element,
      progressPanel(`/patients/${id}/progress`),
    )
  }

  function render() {
    clearInterval(liveTimer)
    liveLoads = []
    unsaved = () => false
    renderBar()
    const current = route()
    let content = null
    if (current === 'signin' || current === 'signup') {
      content = user ? null : authView(current)
    } else if (current === 'google-signup') {
      content = user ? null : googleSignupView()
    } else if (current === 'sessions' && user?.role === 'patient') {
      content = patientView()
    } else if (current === 'plan' && user?.role === 'patient') {
      const plans = patientPlans()
      live(plans.load)
      content = h('div', {}, plans.element)
    } else if (current === 'patients' && user?.role === 'coach') {
      // The roster's question counts follow replies sent from the inbox.
      const roster = rosterPanel()
      const inbox = coachInbox({ onAnswered:roster.load })
      live(inbox.load)
      content = h('div', {}, inbox.element, coachCodePanel(), roster.element)
    } else if (/^patients\/\d+$/.test(current) && user?.role === 'coach') {
      content = patientDetailView(current.split('/')[1])
    } else if (current && accountState === 'ready') {
      // Unknown or not-allowed route: back to the tracker.
      return go('#')
    }
    if (content && !trackerView.hidden) onLeaveTracker()
    if (!content && trackerView.hidden) onShowTracker()
    trackerView.hidden = Boolean(content)
    view.hidden = !content
    view.replaceChildren(...content ? [content] : [])
    if (liveLoads.length) liveTimer = setInterval(refreshLive, 60 * 1000)
  }
  function refreshLive() {
    if (!document.hidden) liveLoads.forEach(load => load())
  }

  async function signedIn(next) {
    user = next
    accountState = 'ready'
    onUser(user ?? null, user?.role === 'patient' ? outbox.records(user.id) : [])
    if (user?.role === 'patient') {
      setSharedWith(await api('GET', '/coaches').then(result => result.coaches, () => []))
      flushAll(user.id)
    } else setSharedWith([])
  }

  async function loadUser() {
    accountState = 'loading'
    renderBar()
    try {
      const me = await api('GET', '/me')
      googleEnabled = me.google === true
      await signedIn(me.user)
    } catch {
      accountState = 'offline'
    }
    render()
  }

  // Leaving a page with an unsaved plan asks first; saying no puts the address back.
  let shownHash = location.hash
  let restoring = false
  window.addEventListener('hashchange', () => {
    if (restoring) { restoring = false; return }
    if (unsaved() && !confirm('Leave this page? Your unsaved plan changes will be lost.')) {
      restoring = true
      location.hash = shownHash
      return
    }
    shownHash = location.hash
    render()
  })
  window.addEventListener('beforeunload', event => { if (unsaved()) event.preventDefault() })
  window.addEventListener('online', () => user && flushAll(user.id))
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !user) return
    flushAll(user.id)
    // Coaches see sessions their patients finished while this tab was in the background;
    // a page with unsaved plan edits only refreshes its other panels.
    if (user.role === 'coach' && route().startsWith('patients') && !unsaved()) render()
    else refreshLive()
  })
  loadUser()

  return {
    // Whether the tracker should cut clips: a signed-in patient who opted in.
    clipsWanted:() => user?.role === 'patient' && user.shareClips === true,
    // Queues a finished run's clips; they upload once the session itself is on the server.
    async saveClips(sessionId, clips) {
      if (!user || user.role !== 'patient' || !user.shareClips) return
      const userId = user.id
      try {
        await clipUploader.add(userId, sessionId, clips)
        setSaveStatus(`Sending ${plural(clips.length, 'clip')} of flagged moments to your coach…`, 'pending')
        await flushAll(userId)
      } catch (error) {
        setSaveStatus(`Could not keep the clips for upload: ${error.message}`, 'warning')
      }
    },
    // Called by the tracker when a run with at least one rep attempt ends.
    saveSession(record, { leaving = false } = {}) {
      if (!record) return
      if (!user) {
        setSaveStatus(`Not saved: ${repsText(record)} of ${exerciseName(record.exercise)}. Sign in to keep your sessions and share them with your coach.`, 'warning')
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
