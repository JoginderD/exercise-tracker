import test from 'node:test'
import assert from 'node:assert/strict'
import { createAngleHistory } from '../src/angle-history.js'

test('tracking loss and long frame gaps break the plotted line', () => {
  const history = createAngleHistory()
  history.add(0, 150)
  history.add(100, 100)
  history.add(200, null)
  history.add(300, 70)
  history.add(1000, 120)
  assert.deepEqual(history.segments(1000).map(s => s.map(p => p.angle)), [[150, 100], [70], [120]])
})

test('the graph only retains the last ten seconds and can reset', () => {
  const history = createAngleHistory()
  history.add(0, 150)
  history.add(10000, 70)
  history.add(10100, 80)
  assert.deepEqual(history.segments(10100).flat().map(p => p.angle), [70, 80])
  history.clear()
  assert.deepEqual(history.segments(10100), [])
})
