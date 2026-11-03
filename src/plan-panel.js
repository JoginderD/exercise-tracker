import { api } from './api.js'
import { h, plural, when, withPending } from './dom.js'
import { exercises } from './exercises.js'
import { weekStart } from './progress.js'
import { PLAN_LIMITS, WEEKDAYS, addDays, dayStart, daysText, doseText, planProgress, planTemplate, planWeek, withDefaults } from './plan.js'
import { planTemplates } from './plan-templates.js'

const UNDO_MS = 2 * 60 * 1000
const exerciseName = id => exercises.find(exercise => exercise.id === id)?.name ?? id
const targetText = item => `${doseText(item)} reps, ${daysText(item)}`
const restText = item => item.rest ? `${item.rest} s rest between sets` : 'no rest needed'
// The tracker opens on this exercise (see src/main.js).
const startHref = exercise => `#?exercise=${encodeURIComponent(exercise)}`
const shortDate = ms => new Date(ms).toLocaleDateString(undefined, { day:'numeric', month:'short' })

// "15 of 30 reps", with a bar and the days so far, or why there is nothing to count.
function progressCell(row) {
  if (!row.tracked) return h('td', { className:'hint', title:'The tracker cannot count this one.' }, 'Not tracked')
  const percent = Math.round(row.done / row.target * 100)
  return h('td', { 'data-state':row.complete ? 'within' : null },
    h('div', { className:'plan-progress' },
      h('span', {}, row.complete ? `Done · ${row.done} reps` : `${row.done} of ${row.target} reps`),
      h('progress', { max:row.target, value:row.done, 'aria-label':`${percent}% of this week's target` })),
    h('span', { className:'hint' }, row.complete ? plural(row.days, 'day') : `${row.remaining} to go · ${plural(row.days, 'day')} so far`))
}

// This week's totals per row, as a table: the coach's view of the same numbers.
function totalsTable(rows, { coach = false } = {}) {
  return h('div', { className:'table-wrap' }, h('table', { className:'data-table plan-table' },
    h('thead', {}, h('tr', {}, ['Exercise', 'Target', 'This week', 'Notes'].map(text => h('th', { scope:'col' }, text)))),
    h('tbody', {}, rows.map(row => h('tr', {},
      h('td', {}, row.name, coach && row.coach ? h('span', { className:'hint' }, `From ${row.coach}`) : null),
      h('td', {}, targetText(row), h('span', { className:'hint' }, restText(row))),
      progressCell(row),
      h('td', { className:'plan-notes' }, row.notes || '—'),
    ))),
  ))
}

// One week of the plan, Monday to Sunday: what is set for each day and what was done.
// fetchWeek(from) returns { items, sessions }, where items may carry the coach's name.
// startable: today's unfinished exercises link to the tracker. footer(data, thisWeek)
// adds anything else that belongs under the week.
const WEEK_RANGE = [-26, 12]
export function planCalendar({ title, fetchWeek, startable = false, emptyText, footer = () => null }) {
  let offset = 0
  let request = 0
  const range = h('span', { className:'calendar-range' })
  const previous = h('button', { type:'button', className:'secondary', 'aria-label':'Previous week' }, '← Previous')
  const thisWeek = h('button', { type:'button', className:'secondary' }, 'This week')
  const next = h('button', { type:'button', className:'secondary', 'aria-label':'Next week' }, 'Next →')
  const content = h('div', { 'aria-live':'polite' }, h('p', { className:'hint' }, 'Loading the week…'))

  function entryState(entry, past) {
    if (!entry.tracked) return ['untracked', 'Off camera']
    if (entry.complete) return ['done', 'Done']
    if (entry.done) return ['partial', `${entry.done} of ${entry.target}`]
    return past ? ['missed', 'Not done'] : ['todo', '']
  }

  function dayCard(day, items, today) {
    const isToday = day.date === today
    const past = day.date < today
    const coaches = new Set(items.map(item => item.coach).filter(Boolean))
    const entries = day.items.map(entry => {
      const [state, status] = entryState(entry, past)
      const coach = coaches.size > 1 ? items[entry.index].coach : null
      return h('li', { className:'calendar-item', 'data-state':state },
        h('div', { className:'calendar-item-head' }, h('strong', {}, entry.name), status ? h('span', { className:'calendar-status' }, status) : null),
        h('span', { className:'calendar-dose' }, `${doseText(entry)} reps${entry.rest ? ` · ${entry.rest} s rest` : ''}${coach ? ` · ${coach}` : ''}`),
        entry.tracked && entry.done && !entry.complete ? h('progress', { max:entry.target, value:entry.done, 'aria-label':`${entry.done} of ${entry.target} reps` }) : null,
        startable && isToday && entry.tracked && !entry.complete ? h('a', { href:startHref(entry.exercise), className:'calendar-start' }, entry.done ? 'Continue' : 'Start') : null,
      )
    })
    const extras = day.extras.map(extra => h('li', { className:'calendar-item calendar-extra', 'data-state':'extra' },
      h('div', { className:'calendar-item-head' }, h('strong', {}, exerciseName(extra.exercise)), h('span', { className:'calendar-status' }, 'Extra')),
      h('span', { className:'calendar-dose' }, `${plural(extra.reps, 'rep')} · not assigned`)))
    return h('li', { className:'calendar-day', 'data-today':isToday ? 'true' : null, 'data-past':past ? 'true' : null,
      'aria-label':`${new Date(day.date).toLocaleDateString(undefined, { weekday:'long', day:'numeric', month:'long' })}${isToday ? ', today' : ''}` },
      h('div', { className:'calendar-date' },
        h('span', { className:'calendar-weekday' }, new Date(day.date).toLocaleDateString(undefined, { weekday:'long' })),
        h('span', { className:'calendar-number' }, shortDate(day.date)),
        isToday ? h('span', { className:'calendar-today' }, 'Today') : null),
      entries.length || extras.length
        ? h('ul', { className:'calendar-items' }, entries, extras)
        : h('p', { className:'calendar-rest' }, 'Rest day'))
  }

  function anyDayList(flexible, items, current) {
    if (!flexible.length) return null
    const several = new Set(items.map(item => item.coach).filter(Boolean)).size > 1
    return h('div', { className:'calendar-anyday' },
      h('h3', {}, 'Any days this week'),
      h('ul', { className:'calendar-items' }, flexible.map(row => {
        const [state, status] = row.tracked
          ? row.complete ? ['done', 'Done'] : row.done ? ['partial', `${row.done} of ${row.target}`] : ['todo', `0 of ${row.target}`]
          : ['untracked', 'Off camera']
        return h('li', { className:'calendar-item', 'data-state':state },
          h('div', { className:'calendar-item-head' }, h('strong', {}, row.name), h('span', { className:'calendar-status' }, status)),
          h('span', { className:'calendar-dose' }, `${doseText(row)} reps, ${daysText(row)}${several ? ` · ${items[row.index].coach}` : ''}`),
          row.tracked && row.done && !row.complete ? h('progress', { max:row.target, value:row.done, 'aria-label':`${row.done} of ${row.target} reps` }) : null,
          startable && current && row.tracked && !row.complete ? h('a', { href:startHref(row.exercise), className:'calendar-start' }, 'Start') : null,
        )
      })))
  }

  async function load() {
    const id = ++request
    const from = addDays(weekStart(Date.now()), offset * 7)
    const current = offset === 0
    range.textContent = `${shortDate(from)} – ${shortDate(addDays(from, 6))}`
    previous.disabled = offset <= WEEK_RANGE[0]
    next.disabled = offset >= WEEK_RANGE[1]
    thisWeek.disabled = current
    try {
      const data = await fetchWeek(from)
      if (id !== request) return
      if (!data.items.length) {
        content.replaceChildren(h('p', { className:'hint' }, emptyText))
        return
      }
      const week = planWeek(data.items, data.sessions, from)
      const today = dayStart(Date.now())
      const pinned = week.days.flatMap(day => day.items.filter(entry => entry.tracked && day.date <= today))
      const todayEntries = week.days.find(day => day.date === today)?.items.filter(entry => entry.tracked) ?? []
      const summary = offset > 0 ? 'Coming up. Plans can change before then.'
        : [pinned.length ? `${current ? 'So far this week' : 'That week'}: ${pinned.filter(entry => entry.complete).length} of ${pinned.length} done` : '',
          current && todayEntries.length ? `today ${todayEntries.filter(entry => entry.complete).length} of ${todayEntries.length}` : '',
        ].filter(Boolean).join(' · ') + (offset < 0 ? '. Shown against the current plan.' : '')
      content.replaceChildren(
        summary ? h('p', { className:'calendar-summary' }, summary) : null,
        h('ol', { className:'calendar' }, week.days.map(day => dayCard(day, data.items, today))),
        anyDayList(week.flexible, data.items, current),
        footer(data, current),
      )
    } catch (error) {
      if (id !== request) return
      content.replaceChildren(h('p', { className:'form-message', 'data-state':'error' }, `${error.message} `,
        h('button', { type:'button', className:'link-button', onclick:load }, 'Try again')))
    }
  }
  const move = step => { offset = step === 0 ? 0 : Math.min(WEEK_RANGE[1], Math.max(WEEK_RANGE[0], offset + step)); load() }
  previous.addEventListener('click', () => move(-1))
  thisWeek.addEventListener('click', () => move(0))
  next.addEventListener('click', () => move(1))
  load()
  return {
    element:h('section', { className:'panel' },
      h('div', { className:'panel-header' }, h('h2', {}, title), h('div', { className:'calendar-nav' }, previous, range, thisWeek, next)),
      content),
    load,
  }
}

// What the patient sees: every coach's plan on one calendar, with this week's totals.
export function patientPlans() {
  return planCalendar({
    title:'Your week',
    startable:true,
    emptyText:'No plan yet. When your coach adds one, the exercises for each day show here.',
    async fetchWeek(from) {
      const { plans, sessions } = await api('GET', `/plans?from=${from}`)
      return { sessions, items:plans.flatMap(plan => plan.items.map(item => ({ ...withDefaults(item), coach:plan.coach.name }))) }
    },
    footer(data, current) {
      if (!current) return null
      const rows = planProgress(data.items, data.sessions).map((row, index) => ({ ...row, coach:data.items[index].coach }))
      return h('details', { className:'calendar-totals' }, h('summary', {}, 'This week\'s totals'),
        totalsTable(rows, { coach:new Set(data.items.map(item => item.coach)).size > 1 }),
        h('p', { className:'hint' }, 'Weeks run Monday to Sunday. Finished sessions count towards the matching exercise.'))
    },
  })
}

// The coach's read-only view of the same calendar for one patient.
export function patientCalendar(patientId) {
  return planCalendar({
    title:'The patient\'s week',
    emptyText:'Nothing to show until a plan is saved.',
    async fetchWeek(from) {
      const { plan, sessions } = await api('GET', `/patients/${patientId}/plan?from=${from}`)
      return { sessions, items:plan.items.map(withDefaults) }
    },
  })
}

const numberInput = (value, [min, max], label) =>
  h('input', { type:'number', inputmode:'numeric', min, max, step:1, value, required:true, 'aria-label':label, className:'plan-number' })

// The coach's editor for one patient's plan: start from a template, upload a CSV, edit rows
// in place, save. Every save sends the version it started from, so two tabs cannot silently
// overwrite each other. onSaved runs after every change the patient can see.
export function planEditor(patientId, { onSaved = () => {} } = {}) {
  const path = `/patients/${patientId}/plan`
  const body = h('tbody')
  const table = h('div', { className:'table-wrap' }, h('table', { className:'data-table plan-table plan-editor' },
    h('thead', {}, h('tr', {}, ['Exercise', 'Counted as', 'Sets', 'Reps', 'Days', 'Rest (s)', 'Notes', 'This week', ''].map(text => h('th', { scope:'col' }, text)))),
    body))
  const message = h('p', { className:'form-message', role:'status' })
  const problems = h('ul', { className:'plan-problems' })
  const status = h('span', { className:'hint plan-status' })
  const save = h('button', { type:'button', disabled:true }, 'Save changes')
  const discard = h('button', { type:'button', className:'secondary', disabled:true }, 'Discard changes')
  const add = h('button', { type:'button', className:'secondary' }, 'Add exercise')
  const file = h('input', { type:'file', accept:'.csv,text/csv,.tsv,.txt', 'aria-label':'Upload a plan as CSV' })
  const templateUrl = URL.createObjectURL(new Blob([planTemplate()], { type:'text/csv' }))
  const empty = h('p', { className:'hint' }, 'No plan yet. Start from a template, upload a CSV, or add exercises one at a time.')
  const template = h('select', { 'aria-label':'Start from a template' },
    h('option', { value:'' }, 'Start from a template…'),
    planTemplates.map(option => h('option', { value:option.id }, `${option.name}: ${option.description}`)))

  let saved = { items:[], version:0, updatedAt:null }
  let sessions = []
  let loaded = false
  let undoTimer

  // Ticking days sets times per week to match; with none ticked, any perWeek days will do.
  function daysCell(item) {
    const perWeek = numberInput(item.perWeek, PLAN_LIMITS.perWeek, 'Times per week, any days')
    perWeek.dataset.field = 'perWeek'
    const chips = WEEKDAYS.map((day, index) => h('label', { className:'day-chip', title:day },
      h('input', { type:'checkbox', value:index, checked:item.days.includes(index), 'aria-label':day, 'data-field':'day' }), day.slice(0, 2)))
    const sync = () => {
      const count = chips.filter(chip => chip.firstChild.checked).length
      perWeek.disabled = count > 0
      if (count) perWeek.value = count
    }
    sync()
    return h('td', { className:'plan-days', onchange:sync },
      h('div', { className:'day-chips', role:'group', 'aria-label':'Days' }, chips),
      h('label', { className:'plan-per-week' }, perWeek, ' × a week'))
  }
  function rowElement(raw) {
    const item = withDefaults(raw)
    const field = (element, name) => { element.dataset.field = name; return element }
    const name = field(h('input', { value:item.name, maxlength:PLAN_LIMITS.name, required:true, 'aria-label':'Exercise name' }), 'name')
    const exercise = field(h('select', { 'aria-label':'Counted as' },
      h('option', { value:'' }, 'Not tracked'), exercises.map(option => h('option', { value:option.id }, option.name))), 'exercise')
    exercise.value = item.exercise ?? ''
    const row = h('tr', {},
      h('td', {}, name), h('td', {}, exercise),
      h('td', {}, field(numberInput(item.sets, PLAN_LIMITS.sets, 'Sets'), 'sets')),
      h('td', {}, field(numberInput(item.reps, PLAN_LIMITS.reps, 'Reps per set'), 'reps')),
      daysCell(item),
      h('td', {}, field(numberInput(item.rest, PLAN_LIMITS.rest, 'Rest between sets, in seconds'), 'rest')),
      h('td', {}, field(h('input', { value:item.notes, maxlength:PLAN_LIMITS.notes, 'aria-label':'Notes', className:'plan-notes-input' }), 'notes')),
      h('td', { className:'plan-week' }),
      h('td', {}, h('button', { type:'button', className:'link-button', onclick:() => remove(row) }, 'Remove')),
    )
    return row
  }
  const visibleRows = () => [...body.children].filter(row => !row.hidden)
  // The rows as typed, in withDefaults key order. The server checks the numbers.
  function current() {
    return visibleRows().map(row => {
      const value = name => row.querySelector(`[data-field="${name}"]`).value
      return withDefaults({ name:value('name').trim(), exercise:value('exercise') || null, sets:Number(value('sets')), reps:Number(value('reps')),
        perWeek:Number(value('perWeek')), days:[...row.querySelectorAll('[data-field="day"]:checked')].map(box => Number(box.value)),
        rest:Number(value('rest')), notes:value('notes').trim() })
    })
  }
  const dirty = () => loaded && JSON.stringify(current()) !== JSON.stringify(saved.items)

  // Progress follows the saved plan; an edited row shows it again once saved.
  function refreshState() {
    const progress = planProgress(saved.items, sessions)
    const rows = current()
    const changed = loaded && JSON.stringify(rows) !== JSON.stringify(saved.items)
    visibleRows().forEach((row, index) => {
      const cell = row.querySelector('.plan-week')
      const same = progress[index] && JSON.stringify(saved.items[index]) === JSON.stringify(rows[index])
      const shown = same ? progressCell(progress[index]) : h('td', {}, h('span', { className:'hint' }, 'Save to update'))
      cell.className = `plan-week ${shown.className}`.trim()
      cell.dataset.state = shown.dataset.state ?? ''
      cell.replaceChildren(...shown.childNodes)
    })
    save.disabled = !changed
    discard.disabled = !changed
    status.textContent = changed ? 'Unsaved changes' : saved.updatedAt ? `Saved ${when(saved.updatedAt)}` : ''
    empty.hidden = rows.length > 0
    table.hidden = rows.length === 0
  }

  function show(plan) {
    saved = { ...plan, items:plan.items.map(withDefaults) }
    loaded = true
    body.replaceChildren(...plan.items.map(rowElement))
    refreshState()
  }

  function remove(row) {
    row.hidden = true
    refreshState()
    const undo = h('button', { type:'button', className:'link-button' }, 'Undo')
    undo.addEventListener('click', () => { row.hidden = false; message.replaceChildren(); refreshState() })
    message.dataset.state = ''
    message.replaceChildren(`Removed ${row.querySelector('[data-field="name"]').value || 'the row'}. Save to make it final. `, undo)
  }

  // Undo of a save or an upload saves the earlier rows again, on top of the new version.
  function offerUndo(text, previous) {
    clearTimeout(undoTimer)
    const undo = h('button', { type:'button', className:'link-button' }, 'Undo')
    message.dataset.state = 'within'
    message.replaceChildren(`${text} `, undo)
    undo.addEventListener('click', () => guarded(undo, 'Undoing…', async () => {
      show((await api('PUT', path, { version:saved.version, items:previous })).plan)
      onSaved()
      message.dataset.state = 'within'
      message.textContent = 'Undone. The patient sees the earlier plan again.'
    }))
    undoTimer = setTimeout(() => { if (message.contains(undo)) message.replaceChildren() }, UNDO_MS)
  }

  // A 409 means another tab or device saved first: offer to load theirs rather than guess a merge.
  function failed(error) {
    message.dataset.state = 'error'
    message.textContent = `${error.message} `
    if (error.status === 409) message.append(h('button', { type:'button', className:'link-button', onclick:() => { loaded = false; load() } }, 'Reload plan'))
    if (error.problems) problems.replaceChildren(...error.problems.map(problem => h('li', {}, `Line ${problem.line}: ${problem.message}`)))
  }
  async function guarded(button, pending, action) {
    problems.replaceChildren()
    await withPending(button, pending, message, async () => {
      try { await action() } catch (error) { failed(error) }
    })
    refreshState()
  }

  save.addEventListener('click', () => guarded(save, 'Saving…', async () => {
    const previous = saved.items
    const result = await api('PUT', path, { version:saved.version, items:current() })
    show(result.plan)
    onSaved()
    offerUndo(`Saved ${plural(result.plan.items.length, 'exercise')}. The patient sees the change now.`, previous)
  }))
  discard.addEventListener('click', () => { show(saved); message.replaceChildren() })
  // A template only fills the rows; nothing reaches the patient until Save.
  template.addEventListener('change', () => {
    const chosen = planTemplates.find(option => option.id === template.value)
    template.value = ''
    if (!chosen) return
    const rows = visibleRows().length
    if (rows && !confirm(`Replace the ${plural(rows, 'row')} below with "${chosen.name}"? Nothing changes for the patient until you save.`)) return
    problems.replaceChildren()
    body.replaceChildren(...chosen.items.map(rowElement))
    refreshState()
    message.dataset.state = ''
    message.textContent = `Filled in from "${chosen.name}". Adjust it for this patient, then Save changes. Discard changes puts the saved plan back.`
  })
  add.addEventListener('click', () => {
    const row = rowElement({ name:'', exercise:null, sets:1, reps:10, perWeek:3, notes:'' })
    body.append(row)
    refreshState()
    row.querySelector('input').focus()
  })
  body.addEventListener('input', refreshState)
  body.addEventListener('change', refreshState)

  file.addEventListener('change', () => {
    const chosen = file.files[0]
    file.value = ''
    if (!chosen) return
    problems.replaceChildren()
    if (chosen.size > PLAN_LIMITS.csvBytes) { failed(new Error('That file is too large for a plan (64 KB at most).')); return }
    if (dirty() && !confirm('Uploading replaces the plan, including your unsaved changes. Continue?')) return
    file.disabled = true
    message.dataset.state = ''
    message.textContent = `Reading ${chosen.name}…`
    chosen.text()
      .then(csv => api('POST', `${path}/csv`, { version:saved.version, csv }))
      .then(result => {
        show(result.plan)
        onSaved()
        offerUndo(`Plan replaced from ${chosen.name}: ${plural(result.plan.items.length, 'exercise')}` +
          `${result.plan.items.some(item => !item.exercise) ? ', some not tracked by the camera (check "Counted as")' : ''}. The patient sees it now.`, result.previous)
      }, failed)
      .finally(() => { file.disabled = false; refreshState() })
  })

  async function load() {
    // Never replace rows the coach is still editing; the next refresh picks up new sessions.
    if (dirty()) return
    try {
      const result = await api('GET', path)
      sessions = result.sessions
      show(result.plan)
    } catch (error) {
      failed(error)
    }
  }
  load()

  const element = h('section', { className:'panel' },
    h('div', { className:'panel-header' }, h('h2', {}, 'Exercise plan'), status),
    h('p', { className:'hint' }, 'Start from a template and adjust it, upload a CSV with columns exercise, sets, reps, per_week, notes, days and rest_seconds (',
      h('a', { href:templateUrl, download:'exercise-plan-template.csv' }, 'download an example'),
      '), or edit the rows below. Tick days to put an exercise on the patient\'s calendar; with no days ticked, any days of the week count. ' +
      'The tracker counts sets and times the rest between them. Exercises it knows are matched by name.'),
    h('div', { className:'plan-sources' }, template, h('label', { className:'plan-upload' }, 'Replace plan from a CSV file ', file)),
    problems, empty, table,
    h('div', { className:'button-row' }, add, save, discard),
    message,
  )
  return { element, load, dirty }
}
