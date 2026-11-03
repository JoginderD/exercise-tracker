import test from 'node:test'
import assert from 'node:assert/strict'
import { matchExercise, parsePlanCsv, planProgress, planTemplate } from '../src/plan.js'

test('a coach spreadsheet with its own headers, quotes and spellings is read', () => {
  const csv = '﻿Exercise;Sets;Reps per set;Times per week;Notes\r\n' +
    'Bicep Curls;3;8-12;3x;"Slow down; squeeze ""at the top"""\r\n' +
    '\r\n' +
    'goblet-squat;;10;;\r\n' +
    'Walk;1;20 min;5;"Outdoors,\nif dry"\r\n'
  const { items, errors } = parsePlanCsv(csv)
  assert.equal(errors, undefined)
  assert.deepEqual(items, [
    { name:'Bicep Curls', exercise:'bicep-curl', sets:3, reps:8, perWeek:3, notes:'Slow down; squeeze "at the top"' },
    { name:'goblet-squat', exercise:'goblet-squat', sets:1, reps:10, perWeek:1, notes:'' },
    { name:'Walk', exercise:null, sets:1, reps:20, perWeek:5, notes:'Outdoors,\nif dry' },
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
