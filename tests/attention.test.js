import test from 'node:test'
import assert from 'node:assert/strict'
import { attentionReasons } from '../server/attention.js'

const DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 10, 3)
const at = days => now - days * DAY
const visit = (days, reps, flaggedReps, safety = false) => ({ startedAt:at(days), reps, flaggedReps, safety })

test('an active patient with steady form needs no attention', () => {
  const sessions = [visit(1, 20, 2), visit(10, 20, 2)]
  assert.deepEqual(attentionReasons({ linkedAt:at(30), lastSessionAt:at(1) }, sessions, now), [])
})

test('a safety alert in the last week is reported with its latest time', () => {
  const sessions = [visit(2, 10, 0, true), visit(5, 10, 0, true), visit(9, 10, 0, true)]
  assert.deepEqual(attentionReasons({ linkedAt:at(30), lastSessionAt:at(2) }, sessions, now), [{ kind:'safety', sessions:2, at:at(2) }])
})

test('flagged reps rising by 15 points or more is reported; smaller rises and tiny samples are not', () => {
  const patient = { linkedAt:at(60), lastSessionAt:at(1) }
  assert.deepEqual(attentionReasons(patient, [visit(1, 20, 8), visit(10, 20, 2)], now), [{ kind:'flagged', from:10, to:40 }])
  assert.deepEqual(attentionReasons(patient, [visit(1, 20, 4), visit(10, 20, 2)], now), [])
  assert.deepEqual(attentionReasons(patient, [visit(1, 4, 4), visit(10, 20, 0)], now), [], 'four reps are too few to judge')
  assert.deepEqual(attentionReasons(patient, [visit(1, 10, 6)], now), [{ kind:'flagged', from:null, to:60 }], 'a first week that is mostly flagged')
})

test('inactivity counts from the last session, or from linking for a patient who never started', () => {
  assert.deepEqual(attentionReasons({ linkedAt:at(60), lastSessionAt:at(9) }, [visit(9, 20, 0)], now), [{ kind:'inactive', days:9, never:false }])
  assert.deepEqual(attentionReasons({ linkedAt:at(8), lastSessionAt:null }, [], now), [{ kind:'inactive', days:8, never:true }])
  assert.deepEqual(attentionReasons({ linkedAt:at(3), lastSessionAt:null }, [], now), [])
})
