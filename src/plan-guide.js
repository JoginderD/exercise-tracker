import { api } from './api.js'
import { h, plural } from './dom.js'
import { exercises } from './exercises.js'
import { weekStart } from './progress.js'
import { sessionTotal } from './session-record.js'
import { dayStart, daysText, doseText, exerciseSets, setProgress, todayPlan, withDefaults } from './plan.js'

const countdown = ms => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const nameOf = id => exercises.find(exercise => exercise.id === id)?.name ?? id
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text
}

// The patient's plan on the tracker: which exercises are on today and how much, the sets
// and the rest between them while the camera runs, and when everything is done. Other
// exercises stay available and are marked as not assigned.
// picker: the exercise buttons' container. note: the line under the instructions.
// setsLabel: the HUD's set counter. panel: the rest / done box over the picture.
// speak(text): reads a cue aloud. onPick(id): choose an exercise, as its button does.
export function createPlanGuide({ picker, note, setsLabel, panel, speak, onPick }) {
  let user = null
  let items = []
  let sessions = []
  let loadError = null
  let loadedDay = null
  let request = 0
  let selected = null
  // Sessions handed to the outbox, counted until a reload from the server includes them.
  const pending = new Map()
  // The camera run being guided: the set reached, and the end of the rest, if resting.
  let live = null
  let cache = null

  const panelTitle = h('p', { className:'plan-cue-title' })
  const panelBig = h('p', { className:'plan-cue-big' })
  const panelDetail = h('p', { className:'plan-cue-detail' })
  const skip = h('button', { type:'button', className:'hud-button' }, 'Skip rest')
  const next = h('button', { type:'button', className:'hud-button' })
  const dismiss = h('button', { type:'button', className:'hud-button' }, 'Keep going')
  panel.replaceChildren(panelTitle, panelBig, panelDetail, h('div', { className:'plan-cue-actions' }, skip, next, dismiss))
  skip.addEventListener('click', () => { if (live) live.restUntil = null; render() })
  dismiss.addEventListener('click', () => { if (live) live.dismissed = true; render() })
  next.addEventListener('click', () => { if (next.dataset.id) onPick(next.dataset.id) })

  const active = () => user?.role === 'patient' && items.length > 0

  // Today's entries, recomputed only when the plan, the sessions or the day change.
  function today() {
    const now = Date.now()
    if (loadedDay !== null && dayStart(now) !== loadedDay && !cache?.reloading) {
      cache = { ...cache, reloading:true }
      load()
    }
    if (cache?.entries && cache.day === dayStart(now)) return cache.entries
    const all = [...sessions, ...pending.values()]
    cache = { day:dayStart(now), entries:todayPlan(items, all, now), all }
    return cache.entries
  }
  const changed = () => { cache = null; renderPicker(); renderNote() }
  // Every rep of the exercise today, beyond the plan too, so sets line up with what was done.
  function repsToday(exercise) {
    const from = dayStart(Date.now())
    today()
    return cache.all.filter(session => session.exercise === exercise && session.startedAt >= from).reduce((sum, session) => sum + session.reps, 0)
  }

  function pickButton(exercise, detail, state) {
    return h('button', { type:'button', 'data-id':exercise.id, 'aria-pressed':String(exercise.id === selected), 'data-plan':state },
      h('span', { className:'pick-name' }, exercise.name), detail ? h('small', { className:'pick-detail' }, detail) : null)
  }

  function renderPicker() {
    if (!active()) {
      picker.className = 'toggle-group exercise-buttons'
      picker.replaceChildren(...exercises.map(exercise => pickButton(exercise)))
      return
    }
    const entries = today()
    const tracked = entries.filter(entry => entry.tracked)
    const todayIds = [...new Set(tracked.map(entry => entry.exercise))]
    const finished = todayIds.filter(id => tracked.filter(entry => entry.exercise === id).every(entry => entry.complete))
    const assigned = todayIds.map(id => {
      const own = tracked.filter(entry => entry.exercise === id)
      const done = own.reduce((sum, entry) => sum + entry.done, 0)
      const target = own.reduce((sum, entry) => sum + entry.target, 0)
      const sets = exerciseSets(own, id).length
      return pickButton(exercises.find(exercise => exercise.id === id),
        finished.includes(id) ? `Done · ${target} reps` : `${plural(sets, 'set')} · ${done} of ${target} reps`,
        finished.includes(id) ? 'done' : 'assigned')
    })
    const offCamera = entries.filter(entry => !entry.tracked).map(entry =>
      h('span', { className:'pick-offcamera' }, h('span', { className:'pick-name' }, entry.name), h('small', { className:'pick-detail' }, `${doseText(entry)} · off camera`)))
    const others = exercises.filter(exercise => !todayIds.includes(exercise.id)).map(exercise => {
      const planned = items.filter(item => item.exercise === exercise.id)
      return pickButton(exercise, planned.length ? `Not today · ${planned.map(daysText).join('; ')}` : 'Not assigned', 'extra')
    })
    picker.className = 'exercise-picker'
    picker.replaceChildren(
      h('div', { className:'picker-group' },
        h('p', { className:'picker-heading' },
          todayIds.length || offCamera.length
            ? h('strong', {}, `Today's plan${todayIds.length ? ` · ${finished.length} of ${todayIds.length} done` : ''}`)
            : h('strong', {}, 'Nothing assigned today'),
          ' ', h('a', { href:'#plan' }, 'See your week')),
        assigned.length || offCamera.length
          ? h('div', { className:'toggle-group exercise-buttons' }, assigned, offCamera)
          : h('p', { className:'hint' }, 'A rest day. Anything you do is saved as extra.')),
      h('div', { className:'picker-group picker-other' },
        h('p', { className:'picker-heading' }, h('strong', {}, 'Other exercises'), ' · not assigned today, still saved for your coach'),
        h('div', { className:'toggle-group exercise-buttons' }, others)),
    )
  }

  function renderNote() {
    if (loadError && !items.length) {
      note.hidden = false
      note.dataset.state = 'error'
      note.replaceChildren(`Could not load your plan (${loadError}). The tracker still works. `,
        h('button', { type:'button', className:'link-button', onclick:load }, 'Try again'))
      return
    }
    if (!active() || !selected) { note.hidden = true; return }
    note.hidden = false
    const own = today().filter(entry => entry.exercise === selected)
    if (!own.length) {
      const planned = items.filter(item => item.exercise === selected)
      note.dataset.state = 'extra'
      note.textContent = planned.length
        ? `Not on today's plan (planned ${planned.map(daysText).join('; ')}). You can still do it: it is saved as extra.`
        : 'Not assigned by your coach. You can still do it: it is saved, and your coach can see it.'
      return
    }
    const sets = exerciseSets(own, selected)
    const done = own.reduce((sum, entry) => sum + entry.done, 0)
    const target = own.reduce((sum, entry) => sum + entry.target, 0)
    const reps = [...new Set(sets.map(set => set.reps))]
    const rests = [...new Set(own.map(entry => entry.rest))]
    const notes = own.map(entry => entry.notes).filter(Boolean)
    note.dataset.state = done >= target ? 'done' : 'assigned'
    note.textContent = (done >= target
      ? `Done for today: ${done} of ${target} reps. More reps are saved as extra.`
      : `On today's plan: ${plural(sets.length, 'set')} of ${reps.length === 1 ? reps[0] : reps.join(' / ')} reps` +
        (rests.length === 1 && rests[0] ? `, ${rests[0]} s rest between sets` : '') + '. ' +
        (done ? `${done} of ${target} reps done so far. ` : '') + 'The tracker counts your sets and tells you when to rest.') +
      (notes.length ? ` Coach's note: ${notes.join(' ')}` : '')
  }

  function hideLive() {
    setsLabel.hidden = true
    panel.hidden = true
  }

  // Runs every frame while the camera runs. liveReps: this run's reps not yet saved.
  function update(liveReps) {
    if (!active() || !live) { hideLive(); return }
    const now = Date.now()
    const own = today().filter(entry => entry.exercise === selected && entry.tracked)
    if (!own.length) {
      setsLabel.hidden = false
      setText(setsLabel, 'Extra · not assigned')
      panel.hidden = true
      return
    }
    const sets = exerciseSets(own, selected)
    const progress = setProgress(sets, repsToday(selected) + liveReps)
    // The first frame only notes where the person starts; sets done earlier are not announced.
    live.index ??= progress.index
    if (progress.index > live.index) {
      const finished = progress.index
      live.index = finished
      live.dismissed = false
      if (progress.complete) {
        live.restUntil = null
        const rest = nextUp()
        speak(`All ${plural(sets.length, 'set')} done. ${nameOf(selected)} is finished for today.` +
          (rest ? ` Next up: ${nameOf(rest)}.` : ' That is everything on today\'s plan. Great work!'))
      } else {
        const rest = sets[finished - 1].rest
        live.restUntil = rest ? now + rest * 1000 : null
        speak(rest ? `Set ${finished} done. Rest for ${rest} seconds.` : `Set ${finished} done. Start set ${finished + 1} when you are ready.`)
      }
    }
    if (live.restUntil && now >= live.restUntil) {
      live.restUntil = null
      speak(`Rest over. Start set ${progress.index + 1} of ${progress.of}.`)
    }
    live.progress = progress
    live.sets = sets
    render()
  }

  // The next exercise on today's plan that is not finished yet.
  function nextUp() {
    return today().find(entry => entry.tracked && !entry.complete && entry.exercise !== selected)?.exercise ?? null
  }

  function render() {
    const { progress, sets } = live ?? {}
    if (!progress) { hideLive(); return }
    setsLabel.hidden = false
    setText(setsLabel, progress.complete ? `All ${sets.length} sets done` : `Set ${progress.index + 1} of ${progress.of} · ${progress.reps}/${progress.target}`)
    if (live.restUntil) {
      panel.hidden = false
      panel.dataset.state = 'rest'
      setText(panelTitle, `Set ${progress.index} done. Rest`)
      setText(panelBig, countdown(live.restUntil - Date.now()))
      setText(panelDetail, `Next: set ${progress.index + 1} of ${progress.of}, ${plural(progress.target, 'rep')}`)
      skip.hidden = false
      next.hidden = true
      dismiss.hidden = true
    } else if (progress.complete && !live.dismissed) {
      const following = nextUp()
      panel.hidden = false
      panel.dataset.state = 'done'
      setText(panelTitle, `${nameOf(selected)} done for today`)
      setText(panelBig, `${plural(sets.length, 'set')} · ${sets.reduce((sum, set) => sum + set.reps, 0)} reps`)
      setText(panelDetail, following ? 'Take a short break before the next exercise.' : 'Everything on today\'s plan is done. Great work!')
      skip.hidden = true
      next.hidden = !following
      next.dataset.id = following ?? ''
      setText(next, following ? `Next: ${nameOf(following)}` : '')
      dismiss.hidden = false
    } else {
      panel.hidden = true
    }
  }

  async function load() {
    if (user?.role !== 'patient') return
    const id = ++request
    const saved = [...pending].filter(([, run]) => run.saved).map(([key]) => key)
    try {
      const result = await api('GET', `/plans?from=${weekStart(Date.now())}`)
      if (id !== request) return
      items = result.plans.flatMap(plan => plan.items.map(item => ({ ...withDefaults(item), coach:plan.coach.name })))
      sessions = result.sessions
      for (const key of saved) pending.delete(key)
      loadError = null
    } catch (error) {
      if (id !== request) return
      loadError = error.message
    }
    loadedDay = dayStart(Date.now())
    changed()
  }

  return {
    // queued: sessions still in the outbox from earlier visits, which the server has not seen.
    setUser(next, queued = []) {
      user = next
      items = []
      sessions = []
      loadError = null
      loadedDay = null
      pending.clear()
      for (const record of queued) pending.set(record.id, { exercise:record.exercise, startedAt:record.startedAt, reps:sessionTotal(record), saved:false })
      live = live && { ...live, index:null }
      changed()
      load()
    },
    outbox(event) {
      if (user?.role !== 'patient') return
      const record = event.record
      if (event.type === 'queued') pending.set(record.id, { exercise:record.exercise, startedAt:record.startedAt, reps:sessionTotal(record), saved:false })
      else if (event.type === 'saved' && pending.has(record.id)) pending.get(record.id).saved = true
      else if (event.type === 'rejected') pending.delete(record.id)
      else return
      cache = null
      if (event.type === 'saved') load()
      else changed()
    },
    select(id) {
      selected = id
      if (live) live = { index:null }
      renderNote()
      if (!active()) hideLive()
    },
    start() { live = { index:null } },
    stop() { live = null; hideLive() },
    update,
    load,
    // While resting or finished, encouragement on the HUD would contradict the box above it.
    quiet:() => Boolean(live?.restUntil || (live?.progress?.complete && !live.dismissed)),
  }
}
