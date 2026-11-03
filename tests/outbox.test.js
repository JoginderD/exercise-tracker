import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutbox } from '../src/api.js'

test('a flush of an empty queue does not block later uploads', async () => {
  const store = new Map()
  globalThis.localStorage = { getItem:key => store.get(key) ?? null, setItem:(key, value) => store.set(key, value) }
  const posted = []
  globalThis.fetch = async (url, options) => {
    posted.push(JSON.parse(options.body).id)
    return { ok:true, status:201, json:async () => ({ id:1 }) }
  }
  try {
    const events = []
    const outbox = createOutbox(event => events.push(event.type))
    await outbox.flush(7)  // what signing in does, with nothing queued
    outbox.add(7, { id:'a', lanes:[] })
    await outbox.flush(7)
    assert.deepEqual(posted, ['a'])
    assert.equal(outbox.pending(7), 0)
    assert.deepEqual(events, ['queued', 'saved'])
  } finally {
    delete globalThis.localStorage
    delete globalThis.fetch
  }
})
