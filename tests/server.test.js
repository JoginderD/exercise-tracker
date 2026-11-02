import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createApp } from '../server/index.js'
import { openStore } from '../server/store.js'

async function startServer() {
  const store = openStore(':memory:')
  const server = createApp({ store })
  await new Promise(done => server.listen(0, done))
  const base = `http://localhost:${server.address().port}`
  return { store, base, close:() => new Promise(done => server.close(done)) }
}

// A tiny cookie-keeping client, one per simulated browser.
function client(base) {
  let cookie = ''
  return async function call(method, path, body, headers = {}) {
    const response = await fetch(base + path, {
      method,
      headers:{ ...body ? { 'content-type':'application/json' } : {}, ...cookie ? { cookie } : {}, ...headers },
      body:body ? JSON.stringify(body) : undefined,
    })
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const type = response.headers.get('content-type') ?? ''
    return { status:response.status, body:type.includes('json') ? await response.json() : await response.text() }
  }
}

function session(overrides = {}) {
  const now = Date.now()
  return {
    id:randomUUID(), exercise:'bicep-curl', source:'camera', side:'each', angles:'3d',
    startedAt:now - 60000, endedAt:now,
    lanes:[{ side:'left', reps:2, flaggedReps:1, partialReps:1, fastReps:1, slowReps:0, history:[
      { kind:'full', number:1, liftMs:800, lowerMs:1500, tempo:'good', flagged:true, messages:[] },
      { kind:'partial', missed:'target', reached:110, messages:['Partial rep: curl the weight higher to count it.'] },
      { kind:'full', number:2, liftMs:300, lowerMs:1500, tempo:'fast', flagged:false, messages:['Too fast'], extra:'dropped' },
    ] }],
    ...overrides,
  }
}

test('patient shares sessions with a coach, who can read them only while linked', async () => {
  const { base, close } = await startServer()
  try {
    const patient = client(base)
    const coach = client(base)
    const stranger = client(base)

    assert.equal((await patient('POST', '/api/sessions', session())).status, 401)
    const signup = await patient('POST', '/api/signup', { email:'Pat@Example.com ', name:'Pat', password:'correct horse', role:'patient' })
    assert.equal(signup.status, 201)
    assert.equal(signup.body.user.email, 'pat@example.com')
    assert.equal((await patient('POST', '/api/signup', { email:'pat@example.com', name:'X', password:'correct horse', role:'patient' })).status, 409)

    const coachUser = (await coach('POST', '/api/signup', { email:'coach@example.com', name:'Coach', password:'correct horse', role:'coach' })).body.user
    assert.match(coachUser.coachCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
    await stranger('POST', '/api/signup', { email:'other@example.com', name:'Other', password:'correct horse', role:'coach' })

    // Saving is idempotent on the client id.
    const record = session()
    assert.equal((await patient('POST', '/api/sessions', record)).status, 201)
    const again = await patient('POST', '/api/sessions', record)
    assert.equal(again.status, 200)
    assert.equal(again.body.duplicate, true)
    assert.equal((await patient('POST', '/api/sessions', session({ exercise:'nope' }))).status, 400)
    assert.equal((await coach('POST', '/api/sessions', session())).status, 403)

    const mine = await patient('GET', '/api/sessions')
    assert.equal(mine.body.sessions.length, 1)
    assert.equal(mine.body.sessions[0].reps, 2)
    const sessionId = mine.body.sessions[0].id

    // Not linked yet: the coach sees nothing.
    assert.deepEqual((await coach('GET', '/api/patients')).body.patients, [])
    assert.equal((await coach('GET', `/api/sessions/${sessionId}`)).status, 404)

    assert.equal((await patient('POST', '/api/coaches', { code:'WRONG-CODE0' })).status, 404)
    const linked = await patient('POST', '/api/coaches', { code:coachUser.coachCode.toLowerCase().replace('-', ' ') })
    assert.equal(linked.status, 201)
    assert.equal(linked.body.coaches[0].name, 'Coach')

    const roster = (await coach('GET', '/api/patients')).body.patients
    assert.equal(roster.length, 1)
    assert.equal(roster[0].sessionCount, 1)
    assert.equal(roster[0].totalReps, 2)
    const detail = await coach('GET', `/api/sessions/${sessionId}`)
    assert.equal(detail.body.session.lanes[0].history.length, 3)
    assert.equal(detail.body.session.lanes[0].history[2].extra, undefined)
    const csv = await coach('GET', `/api/patients/${roster[0].id}/sessions.csv`)
    assert.match(csv.body, /^started_at,exercise/)
    assert.match(csv.body, /Bicep curl,camera,each,3d,60,2,1,1,1,0,0.55,1.50/)

    // Another coach cannot read this patient.
    assert.equal((await stranger('GET', `/api/patients/${roster[0].id}/sessions`)).status, 404)
    assert.equal((await stranger('GET', `/api/sessions/${sessionId}`)).status, 404)

    // Stop sharing cuts access; undo restores it.
    const unlinked = await patient('DELETE', `/api/coaches/${coachUser.id}`)
    assert.deepEqual(unlinked.body.coaches, [])
    assert.equal((await coach('GET', `/api/patients/${roster[0].id}/sessions`)).status, 404)
    const restored = await patient('POST', '/api/coaches/restore', { token:unlinked.body.undo })
    assert.equal(restored.body.coaches.length, 1)
    assert.equal((await patient('POST', '/api/coaches/restore', { token:unlinked.body.undo })).status, 410)
    assert.equal((await coach('GET', `/api/patients/${roster[0].id}/sessions`)).body.sessions.length, 1)

    await patient('POST', '/api/logout', {})
    assert.equal((await patient('GET', '/api/me')).body.user, null)
  } finally {
    await close()
  }
})

test('rejects cross-origin writes, wrong passwords and repeated guessing', async () => {
  const { base, close } = await startServer()
  try {
    const browser = client(base)
    await browser('POST', '/api/signup', { email:'a@example.com', name:'A', password:'correct horse', role:'patient' })
    assert.equal((await browser('POST', '/api/sessions', session(), { origin:'https://evil.example' })).status, 403)
    const form = await fetch(`${base}/api/login`, { method:'POST', headers:{ 'content-type':'application/x-www-form-urlencoded' }, body:'email=a' })
    assert.equal(form.status, 415)

    const guesser = client(base)
    assert.equal((await guesser('POST', '/api/login', { email:'a@example.com', password:'wrong password' })).status, 401)
    let last
    for (let i = 0; i < 10; i++) last = await guesser('POST', '/api/login', { email:'a@example.com', password:'wrong password' })
    assert.equal(last.status, 429)
  } finally {
    await close()
  }
})

test('session history pages newest first without repeats', async () => {
  const { base, close } = await startServer()
  try {
    const browser = client(base)
    await browser('POST', '/api/signup', { email:'p@example.com', name:'P', password:'correct horse', role:'patient' })
    const now = Date.now()
    for (let i = 0; i < 7; i++) await browser('POST', '/api/sessions', session({ startedAt:now - (i + 2) * 60000, endedAt:now - (i + 1) * 60000 }))
    const seen = []
    let cursor = ''
    do {
      const page = (await browser('GET', `/api/sessions?limit=3${cursor ? `&before=${cursor}` : ''}`)).body
      seen.push(...page.sessions.map(item => item.startedAt))
      cursor = page.next
    } while (cursor)
    assert.equal(seen.length, 7)
    assert.deepEqual(seen, [...seen].sort((a, b) => b - a))
  } finally {
    await close()
  }
})
