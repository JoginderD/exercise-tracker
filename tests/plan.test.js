import test from 'node:test'
import assert from 'node:assert/strict'
import { exerciseSets, matchExercise, parsePlanCsv, planDays, planItem, planProgress, planTemplate, planWeek, setProgress, todayPlan, withDefaults } from '../src/plan.js'
import { planTemplates } from '../src/plan-templates.js'

test('a coach spreadsheet with its own headers, quotes and spellings is read', () => {
  const csv = '﻿Exercise;Sets;Reps per set;Times per week;Notes\r\n' +
    'Bicep Curls;3;8-12;3x;"Slow down; squeeze ""at the top"""\r\n' +
    '\r\n' +
    'goblet-squat;;10;;\r\n' +
    'Walk;1;20 min;5;"Outdoors,\nif dry"\r\n'
  const { items, errors } = parsePlanCsv(csv)
  assert.equal(errors, undefined)
  assert.deepEqual(items, [
    { name:'Bicep Curls', exercise:'bicep-curl', sets:3, reps:8, perWeek:3, days:[], rest:60, notes:'Slow down; squeeze "at the top"' },
    { name:'goblet-squat', exercise:'goblet-squat', sets:1, reps:10, perWeek:1, days:[], rest:60, notes:'' },
    { name:'Walk', exercise:null, sets:1, reps:20, perWeek:5, days:[], rest:60, notes:'Outdoors,\nif dry' },
  ])
})

test('a file without a header is read in the template column order', () => {
  const { items } = parsePlanCsv('Squats,2,15,4\nlateral raise,3,12,2,light')
  assert.deepEqual(items.map(item => [item.exercise, item.sets, item.reps, item.perWeek]), [['squat', 2, 15, 4], ['lateral-raise', 3, 12, 2]])
  assert.equal(parsePlanCsv(planTemplate()).items.length, 3)
})

test('bad rows reject the whole file with line numbers', () => {
  const { items, errors } = parsePlanCsv('exercise,sets,reps\nSquat,2,ten\nCurl,0,10\nRow,1,10\n,1,1')
  assert.equal(items, undefined)
  assert.deepEqual(errors.map(error => error.line), [2, 3, 5])
  assert.match(errors[0].message, /reps/)
  assert.ok(parsePlanCsv('').errors)
  assert.ok(parsePlanCsv('exercise,reps\n').errors)
  assert.ok(parsePlanCsv('exercise,sets\nSquat,2').errors, 'reps column is required')
  assert.match(parsePlanCsv(`exercise,reps\n${'Squat,10\n'.repeat(101)}`).errors[0].message, /at most 100/)
})

test('exercise names match ids and display names loosely, and nothing else', () => {
  assert.equal(matchExercise('Dumbbell Rows'), 'dumbbell-row')
  assert.equal(matchExercise('SHOULDER PRESS'), 'shoulder-press')
  assert.equal(matchExercise('press'), null)
})

test('this week counts reps and days per row, sharing reps between duplicate rows', () => {
  const now = new Date(2026, 10, 5, 18).getTime() // Thursday
  const at = (day, hour = 9) => new Date(2026, 10, day, hour).getTime()
  const sessions = [
    { exercise:'squat', startedAt:at(2), reps:20 }, // Monday
    { exercise:'squat', startedAt:at(4), reps:15 },
    { exercise:'squat', startedAt:at(4, 20), reps:0 },
    { exercise:'squat', startedAt:at(1), reps:99 }, // last Sunday: previous week
    { exercise:'bicep-curl', startedAt:at(5), reps:30 },
  ]
  const items = [
    { name:'Squat', exercise:'squat', sets:2, reps:10, perWeek:1, notes:'' },
    { name:'Squat (light)', exercise:'squat', sets:1, reps:10, perWeek:2, notes:'' },
    { name:'Curl', exercise:'bicep-curl', sets:3, reps:10, perWeek:1, notes:'' },
    { name:'Walk', exercise:null, sets:1, reps:20, perWeek:5, notes:'' },
  ]
  const [first, second, curl, walk] = planProgress(items, sessions, now)
  assert.deepEqual([first.done, first.target, first.complete], [20, 20, true])
  assert.deepEqual([second.done, second.target, second.remaining, second.complete], [15, 20, 5, false])
  assert.equal(first.days, 2)
  assert.deepEqual([curl.done, curl.complete], [30, true])
  assert.equal(walk.tracked, false)
  assert.equal(planProgress([], sessions, now).length, 0)
})

test('days and rest columns are read, and times per week follows the days', () => {
  const { items, errors } = parsePlanCsv('exercise,sets,reps,days,rest (s)\nSquat,3,10,"Mon, Wed & Fri",90\nCurl,2,12,weekdays,\nRow,2,8,,0')
  assert.equal(errors, undefined)
  assert.deepEqual(items.map(item => [item.days, item.perWeek, item.rest]), [[[0, 2, 4], 3, 90], [[0, 1, 2, 3, 4], 5, 60], [[], 1, 0]])
  // Old files without the new columns still read, in the old column order.
  assert.deepEqual(parsePlanCsv('Squat,2,15,4,deep').items[0], { name:'Squat', exercise:'squat', sets:2, reps:15, perWeek:4, days:[], rest:60, notes:'deep' })
  assert.deepEqual(parsePlanCsv(planTemplate()).items.map(item => item.days), [[0, 2, 4], [1, 3], []])
  assert.match(parsePlanCsv('exercise,reps,per_week,days\nSquat,10,2,Mon Wed Fri').errors[0].message, /does not match the 3 days/)
  assert.match(parsePlanCsv('exercise,reps,days\nSquat,10,T Th').errors[0].message, /weekday names/)
  assert.match(parsePlanCsv('exercise,reps,rest\nSquat,10,9999').errors[0].message, /rest/)
})

test('weekdays are read however a coach types them', () => {
  assert.deepEqual(planDays('Mon - Fri').value, [0, 1, 2, 3, 4])
  assert.deepEqual(planDays('M/W/F').value, [0, 2, 4])
  assert.deepEqual(planDays('tue and THURSDAY').value, [1, 3])
  assert.deepEqual(planDays('Sat, sun, sat').value, [5, 6])
  assert.deepEqual(planDays('daily').value.length, 7)
  assert.deepEqual(planDays('').value, [])
  assert.deepEqual(planDays([4, 0, 4]).value, [0, 4])
  assert.ok(planDays([7]).error)
  assert.ok(planDays('Fri-Mon').error)
  assert.ok(planDays('someday').error)
})

test('old rows without days or rest get defaults, in a fixed key order', () => {
  const old = { name:'Squat', exercise:'squat', sets:2, reps:10, perWeek:3, notes:'' }
  assert.equal(JSON.stringify(withDefaults(old)), JSON.stringify(planItem({ ...old, sets:'2', reps:'10', perWeek:'3' }).item))
})

test('every built-in template passes the same checks as a saved plan', () => {
  assert.ok(planTemplates.length >= 3)
  for (const template of planTemplates) {
    assert.ok(template.items.length)
    for (const item of template.items) assert.deepEqual(planItem({ ...item, sets:String(item.sets), reps:String(item.reps), perWeek:String(item.perWeek), rest:String(item.rest) }).item, item)
  }
})

const at = (day, hour = 9) => new Date(2026, 10, day, hour).getTime() // November 2026: the 2nd is a Monday
const monday = at(2, 0)

test('the calendar puts rows on their days and counts only that day', () => {
  const items = [
    { name:'Squat', exercise:'squat', sets:2, reps:10, perWeek:3, days:[0, 2, 4], rest:60, notes:'' },
    { name:'Curl', exercise:'bicep-curl', sets:1, reps:10, perWeek:2, days:[], rest:60, notes:'' },
    { name:'Walk', exercise:null, sets:1, reps:20, perWeek:1, days:[6], rest:0, notes:'' },
  ]
  const sessions = [
    { exercise:'squat', startedAt:at(2), reps:20 }, // Monday: done
    { exercise:'squat', startedAt:at(4), reps:12 }, // Wednesday: partly
    { exercise:'squat', startedAt:at(3), reps:9 }, // Tuesday: not set that day, so extra
    { exercise:'bicep-curl', startedAt:at(3), reps:10 }, // counts towards the any-day row
    { exercise:'lateral-raise', startedAt:at(5), reps:8 }, // not in the plan at all
    { exercise:'squat', startedAt:at(9), reps:50 }, // next week
  ]
  const { days, flexible } = planWeek(items, sessions, monday)
  assert.deepEqual(days.map(day => day.items.map(item => item.name)), [['Squat'], [], ['Squat'], [], ['Squat'], [], ['Walk']])
  assert.deepEqual([days[0].items[0].done, days[0].items[0].complete], [20, true])
  assert.deepEqual([days[2].items[0].done, days[2].items[0].target, days[2].items[0].complete], [12, 20, false])
  assert.equal(days[4].items[0].done, 0)
  assert.deepEqual(days[1].extras, [{ exercise:'squat', reps:9 }])
  assert.deepEqual(days[3].extras, [{ exercise:'lateral-raise', reps:8 }])
  assert.equal(days[6].items[0].tracked, false)
  assert.deepEqual(flexible.map(row => [row.name, row.done, row.target]), [['Curl', 10, 20]])
  assert.equal(days[2].date, at(4, 0))
})

test('today holds the rows set for today and the any-day rows still to do', () => {
  const items = [
    { name:'Squat', exercise:'squat', sets:3, reps:10, perWeek:2, days:[2, 4], rest:90, notes:'' },
    { name:'Row', exercise:'dumbbell-row', sets:2, reps:10, perWeek:1, days:[0], rest:60, notes:'' },
    { name:'Curl', exercise:'bicep-curl', sets:2, reps:10, perWeek:2, days:[], rest:45, notes:'' },
    { name:'Press', exercise:'shoulder-press', sets:1, reps:10, perWeek:1, days:[], rest:60, notes:'' },
  ]
  const wednesday = at(4, 18)
  const sessions = [
    { exercise:'bicep-curl', startedAt:at(2), reps:20 }, // one of two curl sessions done on Monday
    { exercise:'shoulder-press', startedAt:at(3), reps:10 }, // press done for the week
    { exercise:'squat', startedAt:at(4, 8), reps:14 }, // this morning
  ]
  const today = todayPlan(items, sessions, wednesday)
  assert.deepEqual(today.map(entry => [entry.name, entry.sessions, entry.target, entry.done]), [['Squat', 1, 30, 14], ['Curl', 1, 20, 0]])
  assert.equal(today[1].anyDay, true)
  // Ten curl sessions a week leave more than one a day near the end of the week.
  const busy = todayPlan([{ ...items[2], perWeek:10 }], [], at(8, 9)) // Sunday
  assert.equal(busy[0].sessions, 10)
})

test('sets follow the reps done today, with each set\'s rest', () => {
  const entries = [
    { exercise:'squat', sets:2, reps:10, sessions:1, rest:90 },
    { exercise:'squat', sets:1, reps:5, sessions:1, rest:30 },
    { exercise:'bicep-curl', sets:3, reps:8, sessions:1, rest:60 },
  ]
  const sets = exerciseSets(entries, 'squat')
  assert.deepEqual(sets, [{ reps:10, rest:90 }, { reps:10, rest:90 }, { reps:5, rest:30 }])
  assert.deepEqual(setProgress(sets, 0), { index:0, of:3, reps:0, target:10, complete:false })
  assert.deepEqual(setProgress(sets, 13), { index:1, of:3, reps:3, target:10, complete:false })
  assert.deepEqual(setProgress(sets, 20), { index:2, of:3, reps:0, target:5, complete:false })
  assert.equal(setProgress(sets, 25).complete, true)
  assert.equal(setProgress(sets, 99).complete, true)
  assert.equal(setProgress([], 0).complete, true)
})
