import test from 'node:test'
import assert from 'node:assert/strict'
import { createClipPlanner } from '../src/clip-planner.js'

const label = (at, extra = {}) => ({ at, kind:'form', text:'x', ...extra })

test('one moment makes one clip from 3 s before to 3 s after, released once it has happened', () => {
  const planner = createClipPlanner()
  planner.mark(label(10000))
  assert.deepEqual(planner.due(12999), [])
  const [clip] = planner.due(13000)
  assert.equal(clip.start, 7000)
  assert.equal(clip.end, 13000)
  assert.equal(clip.labels.length, 1)
  assert.deepEqual(planner.due(20000), [], 'a clip is released once')
})

test('overlapping moments share a clip; separate ones get their own', () => {
  const planner = createClipPlanner()
  planner.mark(label(10000))
  planner.mark(label(14000))
  planner.mark(label(30000))
  const clips = planner.flush()
  assert.deepEqual(clips.map(clip => [clip.start, clip.end, clip.labels.length]), [[7000, 17000, 2], [27000, 33000, 1]])
})

test('a moment reported at its end starts its clip before it began', () => {
  const planner = createClipPlanner()
  planner.mark(label(10000, { from:6500, kind:'tempo' }))
  const [clip] = planner.flush()
  assert.equal(clip.start, 3500)
  assert.equal('from' in clip.labels[0], false)
})

test('a long burst is capped at 20 s, keeping the latest part', () => {
  const planner = createClipPlanner()
  for (let at = 10000; at <= 40000; at += 2000) planner.mark(label(at))
  const [clip, ...rest] = planner.flush()
  assert.deepEqual(rest, [])
  assert.equal(clip.end, 43000)
  assert.equal(clip.end - clip.start, 20000)
})

test('after the per-session limit, later moments are counted but not clipped', () => {
  const planner = createClipPlanner({ maxClips:2 })
  for (const at of [10000, 30000, 50000, 70000]) planner.mark(label(at))
  assert.equal(planner.flush().length, 2)
  assert.equal(planner.dropped, 2)
})
