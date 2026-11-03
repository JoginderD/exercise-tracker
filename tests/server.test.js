import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createApp } from '../server/index.js'
import { openStore } from '../server/store.js'

async function startServer(options = {}) {
  const store = openStore(':memory:')
  const server = createApp({ store, ...options })
  await new Promise(done => server.listen(0, done))
  const base = `http://localhost:${server.address().port}`
  return { store, base, close:() => new Promise(done => server.close(done)) }
}

// A tiny cookie-keeping client, one per simulated browser.
function client(base) {
  let cookie = ''
  return async function call(method, path, body, headers = {}, raw) {
    const response = await fetch(base + path, {
      method,
      headers:{ ...body ? { 'content-type':'application/json' } : {}, ...cookie ? { cookie } : {}, ...headers },
      body:raw ?? (body ? JSON.stringify(body) : undefined),
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

const sensorRep = (number, mcv, loss) => ({ number, mcv, peakVelocity:mcv * 1.6, romCm:40, concentricMs:1000, eccentricMs:2000,
  meanPowerW:40, peakPowerW:70, rotationDeg:110, peakGyroDps:240, velocityLossPct:loss })

test('dumbbell sensor reps are validated, stored, summarised and exported', async () => {
  const { base, close } = await startServer()
  try {
    const browser = client(base)
    await browser('POST', '/api/signup', { email:'s@example.com', name:'S', password:'correct horse', role:'patient' })
    const imu = { sensor:{ name:'Dumbbell-AB12', firmware:'1.0.0' }, hand:'left', massKg:10, lossThresholdPct:25, interruptions:1,
      reps:[sensorRep(1, 0.6, 0), sensorRep(2, 0.5, 16.7), sensorRep(3, 0.42, 30)] }
    assert.equal((await browser('POST', '/api/sessions', session({ imu:{ ...imu, massKg:500 } }))).status, 400)
    assert.equal((await browser('POST', '/api/sessions', session({ imu:{ ...imu, reps:[{ ...sensorRep(1, 0.6, 0), mcv:-1 }] } }))).status, 400)
    assert.equal((await browser('POST', '/api/sessions', session({ imu:{ ...imu, reps:[] } }))).status, 400)
    assert.equal((await browser('POST', '/api/sessions', session({ imu:{ ...imu, sensor:{ name:'x'.repeat(500) }, extra:1 } }))).status, 201)
    assert.equal((await browser('POST', '/api/sessions', session())).status, 201)

    const [withSensor, cameraOnly] = (await browser('GET', '/api/sessions')).body.sessions.sort((a, b) => (b.sensor ? 1 : 0) - (a.sensor ? 1 : 0))
    assert.equal(cameraOnly.sensor, null)
    assert.equal(withSensor.sensor.reps, 3)
    assert.equal(withSensor.sensor.bestMcv, 0.6)
    assert.equal(withSensor.sensor.finalLossPct, 30)
    assert.equal(withSensor.sensor.totalWorkJ, 117.7)

    const detail = (await browser('GET', `/api/sessions/${withSensor.id}`)).body.session
    assert.equal(detail.imu.reps.length, 3)
    assert.equal(detail.imu.sensor.name, null)
    assert.equal(detail.imu.extra, undefined)

    const csv = (await browser('GET', '/api/sessions.csv')).body
    assert.match(csv.split('\n')[0], /sensor_reps,sensor_hand,load_kg,best_velocity_m_s,mean_velocity_m_s,final_velocity_loss_pct,peak_power_w,total_work_j$/)
    assert.match(csv, /,3,left,10,0.6,0.507,30,70,117.7\n/)
    assert.match(csv, /,,,,,,,,\n/)
  } finally {
    await close()
  }
})

test('safety alerts are validated, stored, counted for the coach and exported', async () => {
  const { base, close } = await startServer()
  try {
    const patient = client(base)
    const coach = client(base)
    await patient('POST', '/api/signup', { email:'p@example.com', name:'P', password:'correct horse', role:'patient' })
    const { coachCode } = (await coach('POST', '/api/signup', { email:'c@example.com', name:'C', password:'correct horse', role:'coach' })).body.user
    await patient('POST', '/api/coaches', { code:coachCode })

    const at = Date.now() - 30000
    assert.equal((await patient('POST', '/api/sessions', session({ safety:[{ kind:'kick', at }] }))).status, 400)
    assert.equal((await patient('POST', '/api/sessions', session({ safety:[{ kind:'fall', at:at - 3600000 }] }))).status, 400)
    assert.equal((await patient('POST', '/api/sessions', session({ safety:Array.from({ length:201 }, () => ({ kind:'jerk', at })) }))).status, 400)
    assert.equal((await patient('POST', '/api/sessions', session({ safety:[{ kind:'drop', at }, { kind:'fall', at:at + 500, extra:1 }] }))).status, 201)
    assert.equal((await patient('POST', '/api/sessions', session())).status, 201)

    const sessions = (await patient('GET', '/api/sessions')).body.sessions
    const flagged = sessions.find(item => item.safetyAlerts)
    assert.equal(flagged.safetyAlerts, 2)
    assert.equal(sessions.find(item => !item.safetyAlerts).safetyAlerts, 0)
    const detail = (await patient('GET', `/api/sessions/${flagged.id}`)).body.session
    assert.deepEqual(detail.safety, [{ kind:'drop', at }, { kind:'fall', at:at + 500 }])

    const [roster] = (await coach('GET', '/api/patients')).body.patients
    assert.equal(roster.safetySessions, 1)

    const csv = (await patient('GET', '/api/sessions.csv')).body
    assert.match(csv.split('\n')[0], /avg_lower_s,safety_alerts,sensor_reps/)
    assert.match(csv, /,2 \(Sudden drop; Possible fall\),/)
  } finally {
    await close()
  }
})

test('the dev account switcher is off by default and signs in as any account when on', async () => {
  const off = await startServer()
  try {
    const browser = client(off.base)
    assert.equal((await browser('GET', '/api/dev/users')).status, 404)
    assert.equal((await browser('POST', '/api/dev/switch', { userId:1 })).status, 404)
  } finally { await off.close() }

  const { base, close } = await startServer({ devSwitch:true })
  try {
    const browser = client(base)
    const pat = (await browser('POST', '/api/signup', { email:'pat@example.com', name:'Pat', password:'correct horse', role:'patient' })).body.user
    const coach = (await client(base)('POST', '/api/signup', { email:'coach@example.com', name:'Coach', password:'correct horse', role:'coach' })).body.user
    const { users } = (await browser('GET', '/api/dev/users')).body
    assert.deepEqual(users.map(user => user.id).sort(), [pat.id, coach.id].sort())
    assert.ok(users.every(user => !('password_hash' in user)))

    const switched = await browser('POST', '/api/dev/switch', { userId:coach.id })
    assert.equal(switched.status, 200)
    assert.equal((await browser('GET', '/api/me')).body.user.id, coach.id)
    assert.equal((await browser('POST', '/api/dev/switch', { userId:pat.id })).status, 200)
    assert.equal((await browser('GET', '/api/me')).body.user.id, pat.id)
    assert.equal((await browser('POST', '/api/dev/switch', { userId:9999 })).status, 404)
    assert.equal((await browser('POST', '/api/dev/switch', { userId:'1 OR 1' })).status, 404)
  } finally { await close() }
})

// Smallest byte strings that pass the container check (validate.js looksLike).
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
async function putClip(base, cookieCall, sessionId, clipId, { type = 'video/mp4', body = MP4, meta } = {}) {
  const details = meta ?? { startedAt:Date.now() - 5000, durationMs:6000, labels:[{ kind:'form', lane:'left', rep:2, text:'Upper arm raised.', at:Date.now() - 2000 }] }
  return cookieCall('PUT', `/api/sessions/${sessionId}/clips/${clipId}`, null, {
    'content-type':type, 'x-clip-meta':encodeURIComponent(JSON.stringify(details)),
  }, body)
}

test('clips upload only with sharing on, and a coach sees them only while linked and sharing', async () => {
  const { base, close } = await startServer()
  try {
    const patient = client(base)
    const coach = client(base)
    const otherCoach = client(base)
    await patient('POST', '/api/signup', { email:'pat@example.com', name:'Pat', password:'correct horse', role:'patient' })
    const coachUser = (await coach('POST', '/api/signup', { email:'coach@example.com', name:'Coach', password:'correct horse', role:'coach' })).body.user
    await otherCoach('POST', '/api/signup', { email:'c2@example.com', name:'C2', password:'correct horse', role:'coach' })
    await patient('POST', '/api/coaches', { code:coachUser.coachCode })
    const record = session()
    const clipId = randomUUID()

    assert.equal((await patient('GET', '/api/me')).body.user.shareClips, false)
    assert.equal((await putClip(base, patient, record.id, clipId)).status, 403)
    assert.equal((await patient('PUT', '/api/me/share-clips', { on:true })).body.user.shareClips, true)
    // The session must be on the server first.
    assert.equal((await putClip(base, patient, record.id, clipId)).status, 409)
    const saved = await patient('POST', '/api/sessions', record)
    assert.equal((await putClip(base, patient, record.id, clipId)).status, 201)
    assert.equal((await putClip(base, patient, record.id, clipId)).status, 200, 'a retry stores one clip')
    assert.equal((await putClip(base, patient, record.id, randomUUID(), { body:Buffer.from('<html>not a video</html>') })).status, 400)
    assert.equal((await putClip(base, patient, record.id, randomUUID(), { type:'text/html' })).status, 400)
    assert.equal((await putClip(base, patient, record.id, randomUUID(), { body:Buffer.alloc(7 * 1024 * 1024) })).status, 413)

    const detail = await coach('GET', `/api/sessions/${saved.body.id}`)
    assert.equal(detail.body.session.clips.length, 1)
    assert.deepEqual(detail.body.session.clips[0].labels.map(label => label.rep), [2])
    const clip = detail.body.session.clips[0]
    const video = await coach('GET', `/api/clips/${clip.id}`)
    assert.equal(video.status, 200)
    assert.equal((await otherCoach('GET', `/api/clips/${clip.id}`)).status, 404)

    await patient('PUT', '/api/me/share-clips', { on:false })
    assert.equal((await coach('GET', `/api/sessions/${saved.body.id}`)).body.session.clips.length, 0)
    assert.equal((await coach('GET', `/api/clips/${clip.id}`)).status, 404)
    assert.equal((await patient('GET', `/api/sessions/${saved.body.id}`)).body.session.clips.length, 1, 'the patient still sees their own clips')

    assert.equal((await coach('DELETE', `/api/clips/${clip.id}`)).status, 403)
    assert.equal((await patient('DELETE', `/api/clips/${clip.id}`)).status, 200)
    assert.equal((await patient('GET', `/api/clips/${clip.id}`)).status, 404)
  } finally { await close() }
})

test('the coach roster puts patients who need a look first, with the reasons', async () => {
  const { base, close } = await startServer()
  try {
    const coach = client(base)
    const coachUser = (await coach('POST', '/api/signup', { email:'coach@example.com', name:'Coach', password:'correct horse', role:'coach' })).body.user
    for (const [email, alerts] of [['calm@example.com', []], ['alert@example.com', [{ kind:'fall', at:Date.now() - 1000 }]]]) {
      const patient = client(base)
      await patient('POST', '/api/signup', { email, name:email, password:'correct horse', role:'patient' })
      await patient('POST', '/api/coaches', { code:coachUser.coachCode })
      await patient('POST', '/api/sessions', session({ safety:alerts }))
    }
    const { patients } = (await coach('GET', '/api/patients')).body
    assert.equal(patients[0].email, 'alert@example.com')
    assert.equal(patients[0].attention[0].kind, 'safety')
    assert.deepEqual(patients[1].attention, [])
    const progress = await coach('GET', `/api/patients/${patients[0].id}/progress`)
    assert.equal(progress.body.sessions.length, 1)
    assert.equal(progress.body.sessions[0].reps, 2)
  } finally { await close() }
})

async function linkedPair(base, tag = '') {
  const patient = client(base)
  const coach = client(base)
  const patientUser = (await patient('POST', '/api/signup', { email:`pat${tag}@example.com`, name:`Pat${tag}`, password:'correct horse', role:'patient' })).body.user
  const coachUser = (await coach('POST', '/api/signup', { email:`coach${tag}@example.com`, name:`Coach${tag}`, password:'correct horse', role:'coach' })).body.user
  await patient('POST', '/api/coaches', { code:coachUser.coachCode })
  return { patient, coach, patientUser, coachUser }
}
// The smallest bytes that pass the WebM check.
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60, 1)])
const record = (call, coachId, { type = 'video/webm;codecs=vp8,opus', data = webm, durationMs = 4200, id = randomUUID(), transcript } = {}) =>
  call('PUT', `/api/questions/${id}`, null, { 'content-type':type, 'x-question-meta':encodeURIComponent(JSON.stringify({ coachId, durationMs, transcript })) }, data)

test('questions reach only their coach, are high priority until answered, and the patient sees the reply', async () => {
  const { base, close } = await startServer()
  try {
    const { patient, coach, patientUser, coachUser } = await linkedPair(base)
    const other = await linkedPair(base, '2')

    assert.equal((await coach('POST', '/api/questions', { id:randomUUID(), coachId:coachUser.id, text:'Hi' })).status, 403)
    assert.equal((await patient('POST', '/api/questions', { id:randomUUID(), coachId:coachUser.id, text:'  ' })).status, 400)
    assert.equal((await patient('POST', '/api/questions', { id:randomUUID(), coachId:other.coachUser.id, text:'Hi' })).status, 404)
    assert.equal((await record(patient, coachUser.id, { data:Buffer.from('not a video') })).status, 400)
    assert.equal((await record(patient, coachUser.id, { type:'text/html' })).status, 400)
    assert.equal((await record(patient, coachUser.id, { durationMs:10 * 60 * 1000 })).status, 400)
    assert.equal((await record(patient, other.coachUser.id)).status, 404)
    assert.equal((await record(patient, coachUser.id, { transcript:'x'.repeat(2001) })).status, 400)
    assert.equal((await record(patient, coachUser.id, { transcript:42 })).status, 400)
    assert.equal((await record(coach, coachUser.id)).status, 403)

    // Typed, and recorded on video; the same id twice stores one question.
    const typed = { id:randomUUID(), coachId:coachUser.id, text:'Should my knee click on squats?' }
    assert.equal((await patient('POST', '/api/questions', typed)).status, 201)
    const repeat = await patient('POST', '/api/questions', typed)
    assert.equal(repeat.status, 200)
    assert.equal(repeat.body.duplicate, true)
    const videoId = randomUUID()
    const spoken = await record(patient, coachUser.id, { id:videoId, transcript:'  Is this knee position right?  ' })
    assert.equal(spoken.status, 201)
    assert.equal(spoken.body.question.text, 'Is this knee position right?')
    assert.equal((await record(patient, coachUser.id, { id:videoId })).body.duplicate, true)
    assert.deepEqual(spoken.body.question.recording, { type:'video/webm', durationMs:4200 })
    assert.equal(spoken.body.question.coachName, 'Coach')

    const roster = (await coach('GET', '/api/patients')).body.patients
    assert.equal(roster[0].openQuestions, 2)
    assert.deepEqual(roster[0].attention[0].kind, 'question')
    assert.equal(roster[0].attention[0].priority, 'high')
    const inbox = (await coach('GET', '/api/coach/questions')).body.questions
    assert.deepEqual(inbox.map(question => question.text), ['Should my knee click on squats?', 'Is this knee position right?'])
    assert.equal(inbox[0].patientName, 'Pat')

    // The recording plays for the patient and their coach, and nobody else.
    const audioPath = `/api/questions/${spoken.body.question.id}/recording`
    assert.equal((await fetch(base + audioPath)).status, 401)
    assert.equal((await coach('GET', audioPath)).status, 200)
    assert.equal((await patient('GET', audioPath)).status, 200)
    assert.equal((await other.coach('GET', audioPath)).status, 404)
    assert.equal((await other.coach('POST', `/api/questions/${inbox[0].id}/answer`, { text:'No' })).status, 404)
    assert.equal((await other.coach('GET', `/api/patients/${patientUser.id}/questions`)).status, 404)

    const answered = await coach('POST', `/api/questions/${inbox[0].id}/answer`, { text:'A little is normal. Stop if it hurts.' })
    assert.equal(answered.body.question.answer, 'A little is normal. Stop if it hurts.')
    assert.equal((await coach('GET', '/api/coach/questions')).body.questions.length, 1)
    assert.equal((await coach('GET', '/api/patients')).body.patients[0].openQuestions, 1)
    const mine = (await patient('GET', '/api/questions')).body.questions
    assert.equal(mine.length, 2)
    assert.equal(mine[1].answer, 'A little is normal. Stop if it hurts.')
    assert.equal(mine[1].coachName, 'Coach')
    assert.equal((await coach('GET', `/api/patients/${patientUser.id}/questions`)).body.questions.length, 2)

    // Stopping sharing hides the questions from the coach.
    await patient('DELETE', `/api/coaches/${coachUser.id}`)
    assert.deepEqual((await coach('GET', '/api/coach/questions')).body.questions, [])
    assert.equal((await coach('GET', audioPath)).status, 404)
  } finally {
    await close()
  }
})

test('a coach uploads a CSV plan, edits it, and the patient sees it with this week\'s sessions', async () => {
  const { base, close } = await startServer()
  try {
    const { patient, coach, patientUser, coachUser } = await linkedPair(base)
    const stranger = (await linkedPair(base, '2')).coach
    const path = `/api/patients/${patientUser.id}/plan`
    await patient('POST', '/api/sessions', session({ exercise:'squat' }))

    const empty = (await coach('GET', path)).body
    assert.deepEqual(empty.plan, { items:[], version:0, updatedAt:null })
    assert.equal(empty.sessions[0].exercise, 'squat')
    assert.equal((await stranger('GET', path)).status, 404)
    assert.equal((await patient('GET', path)).status, 403)

    const bad = await coach('POST', `${path}/csv`, { version:0, csv:'exercise,sets,reps\nSquat,2,lots' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.problems[0].line, 2)
    assert.equal((await coach('GET', path)).body.plan.version, 0)

    const uploaded = await coach('POST', `${path}/csv`, { version:0, csv:'exercise,sets,reps,per_week\nSquats,2,10,3\nWalk,1,20,5' })
    assert.equal(uploaded.status, 200)
    assert.equal(uploaded.body.plan.version, 1)
    assert.deepEqual(uploaded.body.previous, [])
    assert.deepEqual(uploaded.body.plan.items.map(item => item.exercise), ['squat', null])

    // An edit from a stale copy is refused rather than overwriting the newer plan.
    const items = uploaded.body.plan.items.map(item => item.exercise === 'squat' ? { ...item, reps:12 } : item)
    assert.equal((await coach('PUT', path, { version:0, items })).status, 409)
    assert.equal((await coach('PUT', path, { version:1, items:[{ ...items[0], exercise:'nope' }] })).status, 400)
    const saved = await coach('PUT', path, { version:1, items })
    assert.equal(saved.body.plan.version, 2)
    assert.equal(saved.body.plan.items[0].reps, 12)
    assert.equal((await stranger('PUT', path, { version:2, items:[] })).status, 404)

    const seen = (await patient('GET', '/api/plans')).body
    assert.equal(seen.plans.length, 1)
    assert.equal(seen.plans[0].coach.name, 'Coach')
    assert.equal(seen.plans[0].items[0].reps, 12)
    assert.equal(seen.sessions.length, 1)

    // Days and rest are kept; times per week must match the days chosen.
    const scheduled = [{ ...items[0], days:[0, 2, 4], perWeek:3, rest:90 }, items[1]]
    const withDays = await coach('PUT', path, { version:2, items:scheduled })
    assert.equal(withDays.status, 200)
    assert.deepEqual([withDays.body.plan.items[0].days, withDays.body.plan.items[0].rest], [[0, 2, 4], 90])
    assert.equal((await coach('PUT', path, { version:3, items:[{ ...scheduled[0], perWeek:2 }] })).status, 400)
    assert.equal((await coach('PUT', path, { version:3, items:[{ ...scheduled[0], days:[9] }] })).status, 400)

    // A calendar asks for one week; sessions outside it are left out, and nonsense weeks refused.
    const started = Date.now() - 60 * 1000
    assert.equal((await patient('GET', `/api/plans?from=${started - 60 * 1000}`)).body.sessions.length, 1)
    assert.equal((await patient('GET', `/api/plans?from=${started + 60 * 60 * 1000}`)).body.sessions.length, 0)
    assert.equal((await patient('GET', `/api/plans?from=${started - 30 * 24 * 60 * 60 * 1000}`)).body.sessions.length, 0)
    assert.equal((await patient('GET', '/api/plans?from=5')).status, 400)
    assert.equal((await coach('GET', `${path}?from=${started - 60 * 1000}`)).body.sessions.length, 1)

    // A coach the patient stopped sharing with no longer shows a plan.
    await patient('DELETE', `/api/coaches/${coachUser.id}`)
    assert.deepEqual((await patient('GET', '/api/plans')).body.plans, [])
  } finally {
    await close()
  }
})
