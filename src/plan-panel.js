import { api } from './api.js'
import { h, plural, when, withPending } from './dom.js'
import { exercises } from './exercises.js'
import { PLAN_LIMITS, planProgress, planTemplate } from './plan.js'

const UNDO_MS = 2 * 60 * 1000
const targetText = item => `${item.sets > 1 ? `${item.sets} × ` : ''}${plural(item.reps, 'rep')}, ${item.perWeek === 1 ? 'once' : `${item.perWeek}×`} a week`

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

// What the patient sees: each coach's plan with this week's progress, read-only.
export function patientPlans() {
  const content = h('div', {}, h('p', { className:'hint' }, 'Loading your plan…'))
  async function load() {
    try {
      const { plans, sessions } = await api('GET', '/plans')
      const withItems = plans.filter(plan => plan.items.length)
      content.replaceChildren(...withItems.length ? withItems.map(plan => {
        const rows = planProgress(plan.items, sessions)
        const tracked = rows.filter(row => row.tracked)
        const done = tracked.filter(row => row.complete).length
        return h('div', { className:'plan' },
          h('p', { className:'hint' }, `From ${plan.coach.name} · updated ${when(plan.updatedAt)}` +
            (tracked.length ? ` · ${done} of ${tracked.length} done this week` : '')),
          h('div', { className:'table-wrap' }, h('table', { className:'data-table plan-table' },
            h('thead', {}, h('tr', {}, ['Exercise', 'Target', 'This week', 'Notes'].map(text => h('th', { scope:'col' }, text)))),
            h('tbody', {}, rows.map(row => h('tr', {},
              h('td', {}, row.name),
              h('td', {}, targetText(row)),
              progressCell(row),
              h('td', { className:'plan-notes' }, row.notes || '—'),
            ))),
          )),
        )
      }) : [h('p', { className:'hint' }, 'No plan yet. When your coach adds one, your targets and this week\'s progress show here.')])
    } catch (error) {
      content.replaceChildren(h('p', { className:'form-message', 'data-state':'error' }, error.message))
    }
  }
  load()
  return {
    element:h('section', { className:'panel' }, h('h2', {}, 'Your exercise plan'),
      h('p', { className:'hint' }, 'Weeks run Monday to Sunday. Finished sessions count towards the matching exercise.'), content),
    load,
  }
}

const numberInput = (value, [min, max], label) =>
  h('input', { type:'number', inputmode:'numeric', min, max, step:1, value, required:true, 'aria-label':label, className:'plan-number' })

// The coach's editor for one patient's plan: upload a CSV, edit rows in place, save.
// Every save sends the version it started from, so two tabs cannot silently overwrite each other.
export function planEditor(patientId) {
  const path = `/patients/${patientId}/plan`
  const body = h('tbody')
  const table = h('div', { className:'table-wrap' }, h('table', { className:'data-table plan-table plan-editor' },
    h('thead', {}, h('tr', {}, ['Exercise', 'Counted as', 'Sets', 'Reps', 'Per week', 'Notes', 'This week', ''].map(text => h('th', { scope:'col' }, text)))),
    body))
  const message = h('p', { className:'form-message', role:'status' })
  const problems = h('ul', { className:'plan-problems' })
  const status = h('span', { className:'hint plan-status' })
  const save = h('button', { type:'button', disabled:true }, 'Save changes')
  const discard = h('button', { type:'button', className:'secondary', disabled:true }, 'Discard changes')
  const add = h('button', { type:'button', className:'secondary' }, 'Add exercise')
  const file = h('input', { type:'file', accept:'.csv,text/csv,.tsv,.txt', 'aria-label':'Upload a plan as CSV' })
  const templateUrl = URL.createObjectURL(new Blob([planTemplate()], { type:'text/csv' }))
  const empty = h('p', { className:'hint' }, 'No plan yet. Upload a CSV or add exercises one at a time.')

  let saved = { items:[], version:0, updatedAt:null }
  let sessions = []
  let loaded = false
  let undoTimer

  function rowElement(item) {
    const name = h('input', { value:item.name, maxlength:PLAN_LIMITS.name, required:true, 'aria-label':'Exercise name' })
    const exercise = h('select', { 'aria-label':'Counted as' },
      h('option', { value:'' }, 'Not tracked'), exercises.map(option => h('option', { value:option.id }, option.name)))
    exercise.value = item.exercise ?? ''
    const row = h('tr', {},
      h('td', {}, name), h('td', {}, exercise),
      h('td', {}, numberInput(item.sets, PLAN_LIMITS.sets, 'Sets')),
      h('td', {}, numberInput(item.reps, PLAN_LIMITS.reps, 'Reps per set')),
      h('td', {}, numberInput(item.perWeek, PLAN_LIMITS.perWeek, 'Times per week')),
      h('td', {}, h('input', { value:item.notes, maxlength:PLAN_LIMITS.notes, 'aria-label':'Notes', className:'plan-notes-input' })),
      h('td', { className:'plan-week' }),
      h('td', {}, h('button', { type:'button', className:'link-button', onclick:() => remove(row) }, 'Remove')),
    )
    return row
  }
  const visibleRows = () => [...body.children].filter(row => !row.hidden)
  // The rows as typed. The server checks the numbers.
  function current() {
    return visibleRows().map(row => {
      const [name, exercise, sets, reps, perWeek, notes] = row.querySelectorAll('input, select')
      return { name:name.value.trim(), exercise:exercise.value || null, sets:Number(sets.value), reps:Number(reps.value),
        perWeek:Number(perWeek.value), notes:notes.value.trim() }
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
    saved = plan
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
    message.replaceChildren(`Removed ${row.querySelector('input').value || 'the row'}. Save to make it final. `, undo)
  }

  // Undo of a save or an upload saves the earlier rows again, on top of the new version.
  function offerUndo(text, previous) {
    clearTimeout(undoTimer)
    const undo = h('button', { type:'button', className:'link-button' }, 'Undo')
    message.dataset.state = 'within'
    message.replaceChildren(`${text} `, undo)
    undo.addEventListener('click', () => guarded(undo, 'Undoing…', async () => {
      show((await api('PUT', path, { version:saved.version, items:previous })).plan)
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
    offerUndo(`Saved ${plural(result.plan.items.length, 'exercise')}. The patient sees the change now.`, previous)
  }))
  discard.addEventListener('click', () => { show(saved); message.replaceChildren() })
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
    h('p', { className:'hint' }, 'Upload a CSV with columns exercise, sets, reps, per_week and notes (',
      h('a', { href:templateUrl, download:'exercise-plan-template.csv' }, 'download a template'),
      '), or edit the rows below. Exercises the tracker knows are matched by name, and the patient\'s sessions count towards them each week (Monday to Sunday).'),
    h('label', { className:'plan-upload' }, 'Replace plan from a CSV file ', file),
    problems, empty, table,
    h('div', { className:'button-row' }, add, save, discard),
    message,
  )
  return { element, load, dirty }
}
