import { exercises } from './exercises.js'
import { weekStart } from './progress.js'

// A coach's exercise plan for one patient: rows of { name, exercise, sets, reps, perWeek, notes }.
// exercise is the tracker's exercise id, or null for something the camera cannot count
// (a walk, a stretch); those rows are kept and shown, but have no progress.
// The server parses uploads with this file (server/index.js), and the page uses it to
// measure this week's sessions against the plan.
export const PLAN_LIMITS = {
  rows:100, csvBytes:64 * 1024, name:80, notes:300,
  sets:[1, 20], reps:[1, 500], perWeek:[1, 14],
}
export const PLAN_COLUMNS = ['exercise', 'sets', 'reps', 'per_week', 'notes']

// Header spellings a coach's spreadsheet might use for each column.
const HEADERS = {
  name:['exercise', 'name', 'movement', 'activity', 'item'],
  sets:['sets', 'set'],
  reps:['reps', 'rep', 'repetitions', 'reps per set'],
  perWeek:['per week', 'times per week', 'sessions per week', 'days per week', 'frequency', 'times a week', 'weekly'],
  notes:['notes', 'note', 'cue', 'cues', 'instructions', 'comments', 'comment'],
}
const headerKey = text => text.toLowerCase().replace(/[_\-/]+/g, ' ').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim()

// "Bicep Curls", "bicep-curl" and "biceps curl" all name the same exercise.
const exerciseKey = text => String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  .map(word => word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word).join('')
const EXERCISE_KEYS = new Map(exercises.flatMap(exercise => [[exerciseKey(exercise.id), exercise.id], [exerciseKey(exercise.name), exercise.id]]))
export const matchExercise = name => EXERCISE_KEYS.get(exerciseKey(name)) ?? null

// RFC 4180 rows: quoted fields may hold the delimiter, quotes ("") and line breaks.
// Each row keeps the line it started on, for error messages.
function csvRows(text, delimiter) {
  const rows = []
  let row = [], field = '', quoted = false, line = 1, rowLine = 1
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') quoted = false
      else { if (char === '\n') line++; field += char }
    } else if (char === '"' && field === '') quoted = true
    else if (char === delimiter) { row.push(field); field = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push({ line:rowLine, cells:row })
      row = []; field = ''; line++; rowLine = line
    } else field += char
  }
  if (field !== '' || row.length) { row.push(field); rows.push({ line:rowLine, cells:row }) }
  return rows.filter(item => item.cells.some(cell => cell.trim() !== ''))
}

// Spreadsheets in some locales save with ; and some exports use tabs.
function guessDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0]
  const counts = [',', ';', '\t'].map(char => [char, first.split(char).length])
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}

// "10", "10 reps", "8-12" (the lower end is the target) or "3x" are all read as numbers.
function whole(text, [min, max], label, fallback) {
  const value = String(text ?? '').trim()
  if (!value) return fallback === undefined ? { error:`${label} is missing` } : { value:fallback }
  const match = /^(\d{1,4})(?:\s*[-–to]+\s*\d{1,4})?\s*[a-z ]*$/i.exec(value)
  const number = match ? Number(match[1]) : NaN
  if (!Number.isInteger(number) || number < min || number > max) return { error:`${label} must be a whole number from ${min} to ${max} (got "${value.slice(0, 20)}")` }
  return { value:number }
}

// Checks one row, from a file or from the editor. Returns { item } or { error }.
export function planItem({ name, exercise, sets, reps, perWeek, notes }) {
  const label = String(name ?? '').trim()
  if (!label) return { error:'exercise is missing' }
  if (label.length > PLAN_LIMITS.name) return { error:`exercise name is longer than ${PLAN_LIMITS.name} characters` }
  const text = String(notes ?? '').trim()
  if (text.length > PLAN_LIMITS.notes) return { error:`notes are longer than ${PLAN_LIMITS.notes} characters` }
  const parsed = { sets:whole(sets, PLAN_LIMITS.sets, 'sets', 1), reps:whole(reps, PLAN_LIMITS.reps, 'reps'),
    perWeek:whole(perWeek, PLAN_LIMITS.perWeek, 'times per week', 1) }
  const failed = Object.values(parsed).find(result => result.error)
  if (failed) return { error:failed.error }
  const tracked = exercise === undefined ? matchExercise(label) : exercise
  if (tracked !== null && !exercises.some(item => item.id === tracked)) return { error:'unknown exercise' }
  return { item:{ name:label, exercise:tracked, sets:parsed.sets.value, reps:parsed.reps.value, perWeek:parsed.perWeek.value, notes:text } }
}

// Returns { items } or { errors:[{ line, message }] }. Any bad row rejects the whole file,
// so a plan is never half replaced.
export function parsePlanCsv(input) {
  const text = String(input ?? '').replace(/^﻿/, '')
  if (!text.trim()) return { errors:[{ line:1, message:'The file is empty.' }] }
  if (text.length > PLAN_LIMITS.csvBytes) return { errors:[{ line:1, message:'The file is too large (64 KB at most).' }] }
  const rows = csvRows(text, guessDelimiter(text))
  // A header row is optional; without one the columns are read in PLAN_COLUMNS order.
  const firstKeys = rows[0].cells.map(headerKey)
  const columnOf = key => firstKeys.findIndex(cell => HEADERS[key].includes(cell))
  const hasHeader = columnOf('name') >= 0 && (columnOf('reps') >= 0 || columnOf('sets') >= 0)
  const columns = hasHeader
    ? Object.fromEntries(Object.keys(HEADERS).map(key => [key, columnOf(key)]))
    : { name:0, sets:1, reps:2, perWeek:3, notes:4 }
  if (hasHeader && columns.reps < 0) return { errors:[{ line:rows[0].line, message:'The header needs a "reps" column.' }] }
  const body = hasHeader ? rows.slice(1) : rows
  if (!body.length) return { errors:[{ line:rows[0].line, message:'The file has a header but no exercises.' }] }
  if (body.length > PLAN_LIMITS.rows) return { errors:[{ line:body[PLAN_LIMITS.rows].line, message:`A plan holds at most ${PLAN_LIMITS.rows} exercises.` }] }
  const items = []
  const errors = []
  for (const row of body) {
    const cell = key => columns[key] >= 0 ? row.cells[columns[key]] : undefined
    const result = planItem({ name:cell('name'), sets:cell('sets'), reps:cell('reps'), perWeek:cell('perWeek'), notes:cell('notes') })
    if (result.error) errors.push({ line:row.line, message:result.error })
    else items.push(result.item)
  }
  return errors.length ? { errors:errors.slice(0, 20) } : { items }
}

export const planTemplate = () => [PLAN_COLUMNS.join(','), 'Bicep curl,3,10,3,Slow on the way down', 'Squat,2,12,2,', 'Walk,1,20,5,Minutes outdoors'].join('\n') + '\n'

// This week's work against each row, Monday to now in the viewer's time zone.
// sessions: [{ exercise, startedAt, reps }]. Reps are shared out in plan order, so two
// rows of the same exercise do not both count the same reps.
export function planProgress(items, sessions, now = Date.now()) {
  const from = weekStart(now)
  const pool = new Map()
  const days = new Map()
  for (const session of sessions) {
    if (session.startedAt < from || session.startedAt > now) continue
    pool.set(session.exercise, (pool.get(session.exercise) ?? 0) + session.reps)
    if (session.reps > 0) {
      const day = new Date(session.startedAt).toDateString()
      days.set(session.exercise, (days.get(session.exercise) ?? new Set()).add(day))
    }
  }
  return items.map(item => {
    if (!item.exercise) return { ...item, tracked:false }
    const target = item.sets * item.reps * item.perWeek
    const available = pool.get(item.exercise) ?? 0
    const done = Math.min(available, target)
    pool.set(item.exercise, available - done)
    return { ...item, tracked:true, target, done, remaining:target - done, days:days.get(item.exercise)?.size ?? 0, complete:done >= target }
  })
}
