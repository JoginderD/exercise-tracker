import { exercises } from './exercises.js'
import { weekStart } from './progress.js'

// A coach's exercise plan for one patient: rows of { name, exercise, sets, reps, perWeek, days, rest, notes }.
// exercise is the tracker's exercise id, or null for something the camera cannot count
// (a walk, a stretch); those rows are kept and shown, but have no progress.
// days are the weekdays it is set for (0 is Monday); empty means any perWeek days of the
// week. rest is the break between sets, in seconds. Rows saved before days and rest
// existed have neither; withDefaults fills them in.
// The server parses uploads with this file (server/index.js), and the page uses it to
// measure this week's sessions against the plan.
export const PLAN_LIMITS = {
  rows:100, csvBytes:64 * 1024, name:80, notes:300,
  sets:[1, 20], reps:[1, 500], perWeek:[1, 14], rest:[0, 600],
}
export const DEFAULT_REST_S = 60
// Files without a header are read in this order; days and rest came later, so they are last.
export const PLAN_COLUMNS = ['exercise', 'sets', 'reps', 'per_week', 'notes', 'days', 'rest_seconds']
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Header spellings a coach's spreadsheet might use for each column.
const HEADERS = {
  name:['exercise', 'name', 'movement', 'activity', 'item'],
  sets:['sets', 'set'],
  reps:['reps', 'rep', 'repetitions', 'reps per set'],
  perWeek:['per week', 'times per week', 'sessions per week', 'days per week', 'frequency', 'times a week', 'weekly'],
  notes:['notes', 'note', 'cue', 'cues', 'instructions', 'comments', 'comment'],
  days:['days', 'day', 'weekdays', 'which days', 'schedule'],
  rest:['rest', 'rest seconds', 'rest s', 'rest sec', 'rest secs', 'rest between sets', 'break', 'rest time'],
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

// "Mon Wed Fri", "mon, wed & fri", "Mon-Fri", "M/W/F", "weekdays", "daily", or the
// editor's list of numbers. Returns { value:[0-6, sorted] } or { error }; empty means any days.
const DAY_NAMES = {
  m:0, mo:0, mon:0, monday:0, tu:1, tue:1, tues:1, tuesday:1, w:2, we:2, wed:2, wednesday:2,
  th:3, thu:3, thur:3, thurs:3, thursday:3, f:4, fr:4, fri:4, friday:4, sa:5, sat:5, saturday:5, su:6, sun:6, sunday:6,
}
const DAY_GROUPS = { daily:[0, 1, 2, 3, 4, 5, 6], everyday:[0, 1, 2, 3, 4, 5, 6], weekdays:[0, 1, 2, 3, 4], weekends:[5, 6], weekend:[5, 6] }
export function planDays(value) {
  const sorted = days => ({ value:[...new Set(days)].sort((a, b) => a - b) })
  if (Array.isArray(value)) {
    return value.length <= 7 && value.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
      ? sorted(value) : { error:'days must be weekdays' }
  }
  const text = String(value ?? '').trim().toLowerCase().replace(/\s*[-–]\s*/g, '-').replace(/every day/g, 'everyday')
  if (!text || text === 'any') return { value:[] }
  const days = []
  for (const part of text.split(/[\s,;/&+.]+/).filter(word => word && word !== 'and')) {
    const range = /^([a-z]+)-([a-z]+)$/.exec(part)
    const [from, to] = range ? [DAY_NAMES[range[1]], DAY_NAMES[range[2]]] : [DAY_NAMES[part], DAY_NAMES[part]]
    if (DAY_GROUPS[part]) days.push(...DAY_GROUPS[part])
    else if (from === undefined || to === undefined || from > to) return { error:`days must be weekday names such as "Mon Wed Fri" (got "${String(value).slice(0, 20)}")` }
    else for (let day = from; day <= to; day++) days.push(day)
  }
  return sorted(days)
}

// Old rows lack days and rest. Keys are always in this order, so rows compare as JSON.
export const withDefaults = ({ name, exercise, sets, reps, perWeek, days = [], rest = DEFAULT_REST_S, notes = '' }) =>
  ({ name, exercise, sets, reps, perWeek, days, rest, notes })

// Checks one row, from a file or from the editor. Returns { item } or { error }.
// With days chosen, times per week is the number of days.
export function planItem({ name, exercise, sets, reps, perWeek, days, rest, notes }) {
  const label = String(name ?? '').trim()
  if (!label) return { error:'exercise is missing' }
  if (label.length > PLAN_LIMITS.name) return { error:`exercise name is longer than ${PLAN_LIMITS.name} characters` }
  const text = String(notes ?? '').trim()
  if (text.length > PLAN_LIMITS.notes) return { error:`notes are longer than ${PLAN_LIMITS.notes} characters` }
  const weekdays = planDays(days)
  if (weekdays.error) return { error:weekdays.error }
  const dayCount = weekdays.value.length
  const parsed = { sets:whole(sets, PLAN_LIMITS.sets, 'sets', 1), reps:whole(reps, PLAN_LIMITS.reps, 'reps'),
    perWeek:whole(perWeek, PLAN_LIMITS.perWeek, 'times per week', dayCount || 1), rest:whole(rest, PLAN_LIMITS.rest, 'rest', DEFAULT_REST_S) }
  const failed = Object.values(parsed).find(result => result.error)
  if (failed) return { error:failed.error }
  if (dayCount && parsed.perWeek.value !== dayCount) {
    return { error:`times per week (${parsed.perWeek.value}) does not match the ${dayCount} day${dayCount === 1 ? '' : 's'} chosen` }
  }
  const tracked = exercise === undefined ? matchExercise(label) : exercise
  if (tracked !== null && !exercises.some(item => item.id === tracked)) return { error:'unknown exercise' }
  return { item:{ name:label, exercise:tracked, sets:parsed.sets.value, reps:parsed.reps.value, perWeek:parsed.perWeek.value,
    days:weekdays.value, rest:parsed.rest.value, notes:text } }
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
    : { name:0, sets:1, reps:2, perWeek:3, notes:4, days:5, rest:6 }
  if (hasHeader && columns.reps < 0) return { errors:[{ line:rows[0].line, message:'The header needs a "reps" column.' }] }
  const body = hasHeader ? rows.slice(1) : rows
  if (!body.length) return { errors:[{ line:rows[0].line, message:'The file has a header but no exercises.' }] }
  if (body.length > PLAN_LIMITS.rows) return { errors:[{ line:body[PLAN_LIMITS.rows].line, message:`A plan holds at most ${PLAN_LIMITS.rows} exercises.` }] }
  const items = []
  const errors = []
  for (const row of body) {
    const cell = key => columns[key] >= 0 ? row.cells[columns[key]] : undefined
    const result = planItem({ name:cell('name'), sets:cell('sets'), reps:cell('reps'), perWeek:cell('perWeek'),
      days:cell('days'), rest:cell('rest'), notes:cell('notes') })
    if (result.error) errors.push({ line:row.line, message:result.error })
    else items.push(result.item)
  }
  return errors.length ? { errors:errors.slice(0, 20) } : { items }
}

export const planTemplate = () => [PLAN_COLUMNS.join(','), 'Bicep curl,3,10,3,Slow on the way down,Mon Wed Fri,60',
  'Squat,2,12,2,,Tue Thu,90', 'Walk,1,20,5,Minutes outdoors,,0'].join('\n') + '\n'

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

// Calendar days in the viewer's time zone. Stepping by setDate, not 24 hours, keeps days
// aligned across daylight saving changes.
export function dayStart(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
export function addDays(ms, days) {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  return date.getTime()
}
export const weekdayOf = ms => (new Date(ms).getDay() + 6) % 7

// The week from Monday `from`, for the calendar. Rows with days sit on those days, one
// session each, and count only that day's reps. Reps a day's rows did not use count
// towards the rows without days (`flexible`, measured like planProgress). Reps of an
// exercise the plan does not hold that day are `extras`: done, but not assigned.
export function planWeek(items, sessions, from) {
  const dates = Array.from({ length:7 }, (_, index) => addDays(from, index))
  const end = addDays(from, 7)
  const pools = dates.map(() => new Map())
  for (const session of sessions) {
    if (session.startedAt < from || session.startedAt >= end || !session.reps) continue
    const pool = pools[weekdayOf(session.startedAt)]
    pool.set(session.exercise, (pool.get(session.exercise) ?? 0) + session.reps)
  }
  const rows = items.map((item, index) => ({ ...withDefaults(item), index }))
  const fixed = rows.filter(row => row.days.length)
  const anyDay = rows.filter(row => !row.days.length)
  const anyDayExercises = new Set(anyDay.map(row => row.exercise))
  const days = dates.map((date, weekday) => {
    const pool = pools[weekday]
    const entries = fixed.filter(row => row.days.includes(weekday)).map(row => {
      if (!row.exercise) return { ...row, tracked:false }
      const target = row.sets * row.reps
      const available = pool.get(row.exercise) ?? 0
      const done = Math.min(available, target)
      pool.set(row.exercise, available - done)
      return { ...row, tracked:true, target, done, complete:done >= target }
    })
    const extras = [...pool].filter(([exercise, reps]) => reps > 0 && !anyDayExercises.has(exercise) && !entries.some(entry => entry.exercise === exercise))
      .map(([exercise, reps]) => ({ exercise, reps }))
    return { date, items:entries, extras }
  })
  const leftover = dates.flatMap((date, weekday) => [...pools[weekday]].map(([exercise, reps]) => ({ exercise, reps, startedAt:date })))
  return { days, flexible:planProgress(anyDay, leftover, end - 1) }
}

// What is on today: rows set for today, plus rows without days that still have sessions
// to do this week, spread over the days left. done is today's reps, shared out in order.
export function todayPlan(items, sessions, now = Date.now()) {
  const today = dayStart(now)
  const weekday = weekdayOf(now)
  const before = planWeek(items, sessions.filter(session => session.startedAt < today), addDays(today, -weekday))
  const entries = []
  items.map(withDefaults).forEach((item, index) => {
    if (item.days.length) {
      if (item.days.includes(weekday)) entries.push({ ...item, index, sessions:1, anyDay:false })
      return
    }
    const week = before.flexible.find(row => row.index === index)
    if (!item.exercise) { entries.push({ ...item, index, sessions:1, anyDay:true }); return }
    if (week.complete) return
    const left = Math.ceil(week.remaining / (item.sets * item.reps))
    entries.push({ ...item, index, sessions:Math.ceil(left / (7 - weekday)), anyDay:true, weekDone:week.done, weekTarget:week.target })
  })
  const pool = new Map()
  for (const session of sessions) {
    if (session.startedAt >= today && session.startedAt <= now) pool.set(session.exercise, (pool.get(session.exercise) ?? 0) + session.reps)
  }
  return entries.map(entry => {
    if (!entry.exercise) return { ...entry, tracked:false }
    const target = entry.sets * entry.reps * entry.sessions
    const available = pool.get(entry.exercise) ?? 0
    const done = Math.min(available, target)
    pool.set(entry.exercise, available - done)
    return { ...entry, tracked:true, target, done, complete:done >= target }
  })
}

// Today's sets of one exercise, in plan order, each with the rest that follows it.
export const exerciseSets = (entries, exercise) => entries.filter(entry => entry.exercise === exercise)
  .flatMap(entry => Array.from({ length:entry.sets * entry.sessions }, () => ({ reps:entry.reps, rest:entry.rest })))

// Where `done` reps leave the person: in set `index` with `reps` of `target` done, or complete.
export function setProgress(sets, done) {
  let left = done
  for (let index = 0; index < sets.length; index++) {
    if (left < sets[index].reps) return { index, of:sets.length, reps:left, target:sets[index].reps, complete:false }
    left -= sets[index].reps
  }
  return { index:sets.length, of:sets.length, reps:0, target:0, complete:true }
}

// "3 × 10", or "10" for a single set.
export const doseText = item => `${item.sets > 1 ? `${item.sets} × ` : ''}${item.reps}`
// "Mon, Wed, Fri", "every day", or "3× a week, any days".
export function daysText(item) {
  const { days, perWeek } = withDefaults(item)
  if (days.length === 7) return 'every day'
  if (days.length) return days.map(day => WEEKDAYS[day]).join(', ')
  return `${perWeek === 1 ? 'once' : `${perWeek}×`} a week, any days`
}
