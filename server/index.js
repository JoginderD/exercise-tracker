import { createServer } from 'node:http'
import { createReadStream, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exercises } from '../src/exercises.js'
import { summariseImu } from '../src/vbt.js'
import { SAFETY_LABELS } from '../src/safety.js'
import { openStore } from './store.js'
import { MAX_CLIP_BYTES, MAX_RECORDING_BYTES, ValidationError, validateAnswer, validateClip, validatePlan, validateProfile, validateQuestion,
  validateRecordedQuestion, validateSession, validateSignup } from './validate.js'
import { parsePlanCsv } from '../src/plan.js'
import { ATTENTION, attentionReasons } from './attention.js'
import { GoogleError, authorizationRequest, createPendingStore, exchangeCode, googleConfigFromEnv } from './google.js'

const COOKIE = 'et_session'
// Binds a Google sign-in to the browser that started it, and holds a Google identity
// between Google's redirect and the step that finishes it (pick a role, or enter the
// existing account's password).
const GOOGLE_STATE = 'et_google_state'
const GOOGLE_PENDING = 'et_google'
const GOOGLE_TTL_S = 10 * 60
const MAX_BODY_BYTES = 512 * 1024
const PAGE_DEFAULT = 25
const PAGE_MAX = 100
const exerciseNames = Object.fromEntries(exercises.map(exercise => [exercise.id, exercise.name]))

class HttpError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details }
}

// Fixed-window counters held in memory: fine for one server process. Behind
// several processes, move these to a shared store.
export function createLimiter(max, windowMs) {
  const hits = new Map()
  return {
    take(key, now = Date.now()) {
      let entry = hits.get(key)
      if (!entry || now >= entry.reset) {
        if (hits.size > 50000) for (const [k, v] of hits) if (now >= v.reset) hits.delete(k)
        entry = { count:0, reset:now + windowMs }
        hits.set(key, entry)
      }
      entry.count++
      if (entry.count > max) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil((entry.reset - now) / 60000)} minutes.`)
    },
  }
}

function parseCookies(header = '') {
  const cookies = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return cookies
}

async function readJson(req) {
  // Requiring JSON blocks plain cross-site form posts, which cannot set this type.
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new HttpError(415, 'Send JSON.')
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { throw new HttpError(400, 'Invalid JSON.') }
}

// Raw uploads (clips). The type is checked by the caller: video types, like JSON,
// cannot be sent by a plain cross-site form.
async function readBytes(req, max) {
  if (Number(req.headers['content-length']) > max) throw new HttpError(413, 'Upload too large.')
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) throw new HttpError(413, 'Upload too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
function headerJson(value, what = 'clip') {
  try { return JSON.parse(decodeURIComponent(String(value ?? ''))) }
  catch { throw new HttpError(400, `Invalid ${what} details.`) }
}
const DAY_MS = 24 * 60 * 60 * 1000
// A week's sessions in any time zone: the browser picks its own Monday from these.
const WEEK_WINDOW_MS = 8 * DAY_MS
const OPEN_QUESTIONS_MAX = 200
// ?from= is the first moment of the week a calendar shows (the viewer's own Monday);
// without it, the last week. Bounded at both ends, so an old week is never cut short by
// the row cap on newer sessions.
const EARLIEST_WEEK = Date.UTC(2024, 0, 1)
function weekWindow(url) {
  const from = url.searchParams.get('from')
  const start = /^\d{1,15}$/.test(from ?? '') ? Number(from) : Date.now() - WEEK_WINDOW_MS
  if (start < EARLIEST_WEEK || start > Date.now() + 366 * DAY_MS) throw new HttpError(400, 'That week is out of range.')
  return [start, start + WEEK_WINDOW_MS]
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...headers })
  res.end(JSON.stringify(body))
}

// Spreadsheet apps run cells starting with these characters as formulas.
const csvCell = value => {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
const CSV_HEADER = ['started_at', 'exercise', 'source', 'side', 'angles', 'duration_s', 'reps', 'flagged_reps',
  'partial_reps', 'too_fast_reps', 'too_slow_reps', 'avg_lift_s', 'avg_lower_s', 'safety_alerts',
  'sensor_reps', 'sensor_hand', 'load_kg', 'best_velocity_m_s', 'mean_velocity_m_s', 'final_velocity_loss_pct',
  'peak_power_w', 'total_work_j']
function sensorCells(row) {
  const imu = row.imu ? JSON.parse(row.imu) : null
  const summary = summariseImu(imu)
  if (!summary) return ['', '', '', '', '', '', '', '']
  return [summary.reps, imu.hand ?? '', imu.massKg ?? '', summary.bestMcv, summary.meanMcv, summary.finalLossPct,
    summary.peakPowerW ?? '', summary.totalWorkJ ?? '']
}
// "2 (Possible fall; Sudden drop)", or 0.
function safetyCell(row) {
  const alerts = row.safety ? JSON.parse(row.safety) : []
  return alerts.length ? `${alerts.length} (${[...new Set(alerts.map(alert => SAFETY_LABELS[alert.kind]))].join('; ')})` : 0
}
function csvRow(row) {
  const full = JSON.parse(row.lanes).flatMap(lane => lane.history.filter(rep => rep.kind === 'full'))
  const average = key => {
    const values = full.map(rep => rep[key]).filter(Number.isFinite)
    return values.length ? (values.reduce((a, b) => a + b, 0) / values.length / 1000).toFixed(2) : ''
  }
  return [new Date(row.started_at).toISOString(), exerciseNames[row.exercise] ?? row.exercise, row.source, row.side,
    row.angles, ((row.ended_at - row.started_at) / 1000).toFixed(0), row.reps, row.flagged_reps, row.partial_reps,
    row.fast_reps, row.slow_reps, average('liftMs'), average('lowerMs'), safetyCell(row), ...sensorCells(row)].map(csvCell).join(',')
}
function sendCsv(res, rows, filename) {
  res.writeHead(200, {
    'content-type':'text/csv; charset=utf-8',
    'content-disposition':`attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`,
    'cache-control':'no-store',
  })
  res.write(CSV_HEADER.join(',') + '\n')
  for (const row of rows) res.write(csvRow(row) + '\n')
  res.end()
}

function pageArgs(url) {
  const limit = Number(url.searchParams.get('limit'))
  return [url.searchParams.get('before'), Number.isInteger(limit) && limit > 0 ? Math.min(limit, PAGE_MAX) : PAGE_DEFAULT]
}
const numericId = value => /^\d{1,15}$/.test(value) ? Number(value) : null

function redirect(res, location, cookies = []) {
  res.writeHead(302, { location, 'cache-control':'no-store', 'set-cookie':cookies })
  res.end()
}

// google: { clientId, clientSecret, redirectUri? } turns on Sign in with Google (see google.js).
// devSwitch adds password-free account switching for testing. It lets anyone sign in
// as anyone, so it must never be on in production.
export function createApp({ store, staticDir, secureCookies = false, google = null, devSwitch = false } = {}) {
  const loginByIp = createLimiter(30, 15 * 60 * 1000)
  const loginByEmail = createLimiter(10, 15 * 60 * 1000)
  const signupByIp = createLimiter(10, 60 * 60 * 1000)
  const linkByUser = createLimiter(10, 15 * 60 * 1000)
  const saveByUser = createLimiter(600, 60 * 60 * 1000)
  const clipByUser = createLimiter(300, 60 * 60 * 1000)
  const googleByIp = createLimiter(30, 15 * 60 * 1000)
  const askByUser = createLimiter(60, 60 * 60 * 1000)
  const planByUser = createLimiter(300, 60 * 60 * 1000)
  const googleFlows = createPendingStore(GOOGLE_TTL_S * 1000)
  const googlePending = createPendingStore(GOOGLE_TTL_S * 1000)

  const setCookie = (name, value, maxAge, path = '/') =>
    `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`
  const cookie = (value, maxAge) => setCookie(COOKIE, value, maxAge)
  const clearPending = setCookie(GOOGLE_PENDING, '', 0, '/api')

  // Replaces whatever session this browser had, so an old token does not stay valid.
  function signIn(ctx, userId) {
    store.endSession(ctx.token)
    const session = store.startSession(userId)
    return cookie(session.token, session.maxAge)
  }
  // Google redirects the browser here, so this must match a URI registered for the client.
  function googleRedirectUri(req) {
    if (google.redirectUri) return google.redirectUri
    const first = value => String(value ?? '').split(',')[0].trim()
    const proto = first(req.headers['x-forwarded-proto']) || (secureCookies ? 'https' : 'http')
    return `${proto}://${first(req.headers['x-forwarded-host']) || req.headers.host}/api/auth/google/callback`
  }

  function requireUser(ctx, role) {
    if (!ctx.user) throw new HttpError(401, 'Please sign in.')
    if (role && ctx.user.role !== role) throw new HttpError(403, `Only ${role} accounts can do this.`)
    return ctx.user
  }
  // A coach may read a patient's data only while that patient shares with them.
  function requirePatientOf(ctx, patientId) {
    const coach = requireUser(ctx, 'coach')
    if (patientId === null || !store.isLinked(patientId, coach.id)) throw new HttpError(404, 'Patient not found.')
    return store.userById(patientId)
  }
  function saveQuestion(user, question) {
    if (!store.isLinked(user.id, question.coachId)) throw new HttpError(404, 'You are not sharing with that coach.')
    const result = store.saveQuestion(user.id, question)
    return [result.duplicate ? 200 : 201, result]
  }
  // The patient who asked, or the coach asked while the patient still shares with them.
  function canSeeQuestion(user, question) {
    return question && (question.patientId === user.id ||
      (user.role === 'coach' && question.coachId === user.id && store.isLinked(question.patientId, user.id)))
  }

  // One-use, short-lived undo tokens for "stop sharing", kept in memory.
  const restoreTokens = (() => {
    const tokens = new Map()
    return {
      issue(patientId, coach) {
        const token = randomUUID()
        tokens.set(token, { patientId, coachId:coach.id, linkedAt:coach.linkedAt, expires:Date.now() + 2 * 60 * 1000 })
        for (const [key, value] of tokens) if (value.expires < Date.now()) tokens.delete(key)
        return token
      },
      redeem(token, patientId) {
        const entry = tokens.get(token)
        tokens.delete(token)
        return entry && entry.patientId === patientId && entry.expires > Date.now() ? entry : null
      },
    }
  })()

  const routes = [
    ['GET', /^\/api\/me$/, ctx => ({ user:ctx.user, google:Boolean(google) })],
    ['POST', /^\/api\/signup$/, async ctx => {
      signupByIp.take(ctx.ip)
      const input = validateSignup(await readJson(ctx.req))
      const user = await store.createUser(input)
      if (!user) throw new HttpError(409, 'An account with that email already exists. Sign in instead.')
      return [201, { user }, { 'set-cookie':signIn(ctx, user.id) }]
    }],
    ['POST', /^\/api\/login$/, async ctx => {
      const body = await readJson(ctx.req)
      loginByIp.take(ctx.ip)
      loginByEmail.take(String(body.email ?? '').trim().toLowerCase())
      const user = await store.checkLogin(body.email, body.password)
      if (!user) throw new HttpError(401, 'Email or password is incorrect.')
      // Google sent this browser here because the account already existed: the password
      // proves it owns the account, Google proved it owns the email, so the two are joined.
      const pendingToken = ctx.cookies[GOOGLE_PENDING]
      const pending = googlePending.peek(pendingToken)
      const linking = pending?.kind === 'link' && pending.email === user.email
      if (linking) googlePending.take(pendingToken)
      const linkedGoogle = linking && store.linkGoogle(user.id, pending.sub)
      return { user, linkedGoogle, headers:{ 'set-cookie':[signIn(ctx, user.id), ...linking ? [clearPending] : []] } }
    }],

    ['GET', /^\/api\/auth\/google\/start$/, ctx => {
      if (!google) throw new HttpError(404, 'Sign in with Google is not set up on this server.')
      try { googleByIp.take(ctx.ip) }
      catch { return redirect(ctx.res, '/#signin?google=busy') }
      const request = authorizationRequest(google, googleRedirectUri(ctx.req))
      googleFlows.put(request.flow, request.state)
      redirect(ctx.res, request.url, [setCookie(GOOGLE_STATE, request.state, GOOGLE_TTL_S, '/api/auth/google')])
    }],
    // Google sends the browser back here. Every outcome redirects into the app, which
    // shows the result: signed in, finish signing up, enter your password, or an error.
    ['GET', /^\/api\/auth\/google\/callback$/, async ctx => {
      const done = (hash, cookies = []) => redirect(ctx.res, `/#${hash}`, [setCookie(GOOGLE_STATE, '', 0, '/api/auth/google'), ...cookies])
      const params = ctx.url.searchParams
      const state = params.get('state')
      // The state must match this browser's cookie, so another site cannot finish a sign-in it started.
      const flow = google && state && state === ctx.cookies[GOOGLE_STATE] ? googleFlows.take(state) : null
      if (params.get('error')) return done('signin?google=cancelled')
      if (!flow) return done('signin?google=expired')
      let identity
      try {
        identity = await exchangeCode(google, params.get('code') ?? '', flow)
      } catch (error) {
        if (!(error instanceof GoogleError)) throw error
        console.warn(error.message)
        return done('signin?google=failed')
      }
      const user = store.userByGoogleSub(identity.sub)
      if (user) return done(user.role === 'coach' ? 'patients' : '', [signIn(ctx, user.id)])
      const existing = store.emailAccount(identity.email)
      if (existing?.googleSub) return done('signin?google=other-account')
      const token = googlePending.put({ kind:existing ? 'link' : 'signup', ...identity })
      return done(existing ? 'signin?google=link' : 'google-signup', [setCookie(GOOGLE_PENDING, token, GOOGLE_TTL_S, '/api')])
    }],
    ['GET', /^\/api\/auth\/google\/pending$/, ctx => {
      const pending = googlePending.peek(ctx.cookies[GOOGLE_PENDING])
      return { pending:pending && { kind:pending.kind, email:pending.email, name:pending.name } }
    }],
    // A new Google user picks a name and role; the email and Google id come from the pending sign-in.
    ['POST', /^\/api\/auth\/google\/complete$/, async ctx => {
      signupByIp.take(ctx.ip)
      const profile = validateProfile(await readJson(ctx.req))
      const pendingToken = ctx.cookies[GOOGLE_PENDING]
      const pending = googlePending.peek(pendingToken)
      if (pending?.kind !== 'signup') throw new HttpError(410, 'Google sign-in has expired. Continue with Google again.')
      const user = await store.createUser({ ...profile, email:pending.email, password:null, googleSub:pending.sub })
      if (!user) throw new HttpError(409, 'An account with that email already exists. Sign in instead.')
      googlePending.take(pendingToken)
      return [201, { user }, { 'set-cookie':[signIn(ctx, user.id), clearPending] }]
    }],
    ['POST', /^\/api\/logout$/, ctx => {
      store.endSession(ctx.token)
      return { ok:true, headers:{ 'set-cookie':cookie('', 0) } }
    }],

    ['POST', /^\/api\/sessions$/, async ctx => {
      const user = requireUser(ctx, 'patient')
      saveByUser.take(user.id)
      const result = store.saveSession(user.id, validateSession(await readJson(ctx.req)))
      return [result.duplicate ? 200 : 201, result]
    }],
    ['GET', /^\/api\/sessions$/, ctx => store.listSessions(requireUser(ctx, 'patient').id, ...pageArgs(ctx.url))],
    ['GET', /^\/api\/sessions\.csv$/, ctx => {
      const user = requireUser(ctx, 'patient')
      sendCsv(ctx.res, store.iterateSessions(user.id), 'my-exercise-sessions.csv')
    }],
    ['GET', /^\/api\/sessions\/(\d+)$/, (ctx, id) => {
      const user = requireUser(ctx)
      const session = store.getSession(Number(id))
      const allowed = session && (session.userId === user.id || (user.role === 'coach' && store.isLinked(session.userId, user.id)))
      if (!allowed) throw new HttpError(404, 'Session not found.')
      const { userId, ...rest } = session
      // A coach sees clips only while the patient has clip sharing on.
      if (userId !== user.id && !store.userById(userId).shareClips) rest.clips = []
      return { session:rest }
    }],

    // Clips of flagged moments: the body is the video, its details are in x-clip-meta.
    // Keyed by the session's and the clip's client ids, so retries store one clip.
    ['PUT', /^\/api\/sessions\/([0-9a-fA-F-]{36})\/clips\/([0-9a-fA-F-]{36})$/, async (ctx, sessionId, clipId) => {
      const user = requireUser(ctx, 'patient')
      if (!user.shareClips) throw new HttpError(403, 'Clip sharing is off.')
      clipByUser.take(user.id)
      const type = ctx.req.headers['content-type']
      const meta = headerJson(ctx.req.headers['x-clip-meta'])
      const clip = validateClip({ id:clipId, type, meta, data:await readBytes(ctx.req, MAX_CLIP_BYTES) })
      const result = store.saveClip(user.id, sessionId.toLowerCase(), clip)
      if (!result) throw new HttpError(409, 'Upload the session before its clips.')
      if (result === 'full') throw new HttpError(422, 'This session already has its maximum number of clips.')
      return [result.duplicate ? 200 : 201, result]
    }],
    ['GET', /^\/api\/clips\/(\d+)$/, (ctx, id) => {
      const user = requireUser(ctx)
      const clip = store.getClip(Number(id))
      const allowed = clip && (clip.userId === user.id ||
        (user.role === 'coach' && clip.shareClips && store.isLinked(clip.userId, user.id)))
      if (!allowed) throw new HttpError(404, 'Clip not found.')
      ctx.res.writeHead(200, {
        'content-type':clip.type, 'content-length':clip.data.length, 'cache-control':'private, no-store',
        'x-content-type-options':'nosniff', 'content-disposition':'inline',
      })
      ctx.res.end(clip.data)
    }],
    ['DELETE', /^\/api\/clips\/(\d+)$/, (ctx, id) => {
      const user = requireUser(ctx, 'patient')
      if (!store.deleteClip(Number(id), user.id)) throw new HttpError(404, 'Clip not found.')
      return { ok:true }
    }],
    ['PUT', /^\/api\/me\/share-clips$/, async ctx => {
      const user = requireUser(ctx, 'patient')
      const { on } = await readJson(ctx.req)
      if (typeof on !== 'boolean') throw new HttpError(400, 'on must be true or false.')
      return { user:store.setShareClips(user.id, on) }
    }],
    // Weekly progress is bucketed in the browser, in the viewer's own time zone.
    ['GET', /^\/api\/progress$/, ctx => ({ sessions:store.progress(requireUser(ctx, 'patient').id, Date.now() - 12 * 7 * DAY_MS) })],

    ['GET', /^\/api\/coaches$/, ctx => ({ coaches:store.coachesOf(requireUser(ctx, 'patient').id) })],
    ['POST', /^\/api\/coaches$/, async ctx => {
      const user = requireUser(ctx, 'patient')
      linkByUser.take(user.id)
      const coach = store.linkCoach(user.id, (await readJson(ctx.req)).code)
      if (!coach) throw new HttpError(404, 'No coach has that code. Check it with your coach.')
      return [201, { coach, coaches:store.coachesOf(user.id) }]
    }],
    ['DELETE', /^\/api\/coaches\/(\d+)$/, (ctx, id) => {
      const user = requireUser(ctx, 'patient')
      const coach = store.coachesOf(user.id).find(item => item.id === Number(id))
      if (coach) store.unlinkCoach(user.id, coach.id)
      return { coaches:store.coachesOf(user.id), undo:coach ? restoreTokens.issue(user.id, coach) : null }
    }],
    // Lets a patient undo "stop sharing" without needing the coach's code again.
    ['POST', /^\/api\/coaches\/restore$/, async ctx => {
      const user = requireUser(ctx, 'patient')
      const { token } = await readJson(ctx.req)
      const restored = restoreTokens.redeem(token, user.id)
      if (!restored) throw new HttpError(410, 'Undo has expired. Ask your coach for their code to share again.')
      store.restoreLink(user.id, restored.coachId, restored.linkedAt)
      return { coaches:store.coachesOf(user.id) }
    }],

    ['POST', /^\/api\/coach-code$/, ctx => ({ user:store.rotateCoachCode(requireUser(ctx, 'coach').id) })],
    ['GET', /^\/api\/patients$/, ctx => {
      const coach = requireUser(ctx, 'coach')
      const now = Date.now()
      const recent = Map.groupBy(store.recentSessionsOfCoach(coach.id, now - (ATTENTION.recentDays + ATTENTION.priorDays) * DAY_MS),
        session => session.userId)
      const questions = store.openQuestionCounts(coach.id)
      const patients = store.patientsOf(coach.id).map(patient => ({ ...patient, openQuestions:questions.get(patient.id)?.count ?? 0,
        attention:attentionReasons({ ...patient, openQuestions:questions.get(patient.id) }, recent.get(patient.id) ?? [], now) }))
      // Unanswered questions first, then other patients who need a look; otherwise the
      // store's order (most recent session first).
      const rank = patient => patient.openQuestions ? 2 : patient.attention.length ? 1 : 0
      patients.sort((a, b) => rank(b) - rank(a))
      return { patients }
    }],
    ['GET', /^\/api\/patients\/(\d+)\/progress$/, (ctx, id) => {
      const patient = requirePatientOf(ctx, numericId(id))
      return { sessions:store.progress(patient.id, Date.now() - 12 * 7 * DAY_MS) }
    }],
    ['GET', /^\/api\/patients\/(\d+)\/sessions$/, (ctx, id) => {
      const patient = requirePatientOf(ctx, numericId(id))
      return { patient, ...store.listSessions(patient.id, ...pageArgs(ctx.url)) }
    }],
    ['GET', /^\/api\/patients\/(\d+)\/sessions\.csv$/, (ctx, id) => {
      const patient = requirePatientOf(ctx, numericId(id))
      sendCsv(ctx.res, store.iterateSessions(patient.id), `${patient.name}-exercise-sessions.csv`)
    }],

    // Exercise plans. The coach's plan for one patient, with that patient's sessions from
    // about the last week so the page can show this week's progress against each row.
    ['GET', /^\/api\/patients\/(\d+)\/plan$/, (ctx, id) => {
      const patient = requirePatientOf(ctx, numericId(id))
      return { plan:store.plan(patient.id, ctx.user.id), sessions:store.weekSessions(patient.id, ...weekWindow(ctx.url)) }
    }],
    ['PUT', /^\/api\/patients\/(\d+)\/plan$/, async (ctx, id) => {
      const patient = requirePatientOf(ctx, numericId(id))
      planByUser.take(ctx.user.id)
      const { items, version } = validatePlan(await readJson(ctx.req))
      const plan = store.savePlan(patient.id, ctx.user.id, items, version)
      if (!plan) throw new HttpError(409, 'This plan was changed somewhere else (another tab or device). Reload it to see the latest, then make your change again.')
      return { plan }
    }],
    // A CSV upload replaces the plan. The old rows come back so the page can offer undo.
    ['POST', /^\/api\/patients\/(\d+)\/plan\/csv$/, async (ctx, id) => {
      const patient = requirePatientOf(ctx, numericId(id))
      planByUser.take(ctx.user.id)
      const body = await readJson(ctx.req)
      if (!Number.isInteger(body.version) || body.version < 0) throw new HttpError(400, 'version is required')
      const parsed = parsePlanCsv(body.csv)
      if (parsed.errors) throw new HttpError(400, 'The file has problems, so the plan was not changed.', { problems:parsed.errors })
      const previous = store.plan(patient.id, ctx.user.id)
      const plan = store.savePlan(patient.id, ctx.user.id, parsed.items, body.version)
      if (!plan) throw new HttpError(409, 'This plan was changed somewhere else (another tab or device). Reload it, then upload the file again.')
      return { plan, previous:previous.items }
    }],
    ['GET', /^\/api\/plans$/, ctx => {
      const user = requireUser(ctx, 'patient')
      return { plans:store.plansOfPatient(user.id), sessions:store.weekSessions(user.id, ...weekWindow(ctx.url)) }
    }],

    // Questions from a patient to one of their coaches: typed (JSON), or recorded on
    // the tracker (the body is the video, its details are in x-question-meta). Both are
    // keyed by the client's id, so a retry stores one question.
    ['POST', /^\/api\/questions$/, async ctx => {
      const user = requireUser(ctx, 'patient')
      askByUser.take(user.id)
      return saveQuestion(user, validateQuestion(await readJson(ctx.req)))
    }],
    ['PUT', /^\/api\/questions\/([0-9a-fA-F-]{36})$/, async (ctx, clientId) => {
      const user = requireUser(ctx, 'patient')
      askByUser.take(user.id)
      const meta = headerJson(ctx.req.headers['x-question-meta'], 'question')
      // Checked before the upload is read, so a stranger to this coach cannot make the server hold 16 MB.
      if (!Number.isInteger(meta?.coachId) || !store.isLinked(user.id, meta.coachId)) throw new HttpError(404, 'You are not sharing with that coach.')
      return saveQuestion(user, validateRecordedQuestion({ id:clientId, type:ctx.req.headers['content-type'], meta,
        data:await readBytes(ctx.req, MAX_RECORDING_BYTES) }))
    }],
    ['GET', /^\/api\/questions$/, ctx => store.questionsOfPatient(requireUser(ctx, 'patient').id, ...pageArgs(ctx.url))],
    ['GET', /^\/api\/questions\/(\d+)\/recording$/, (ctx, id) => {
      const user = requireUser(ctx)
      const recording = store.questionRecording(Number(id))
      if (!canSeeQuestion(user, recording)) throw new HttpError(404, 'Recording not found.')
      ctx.res.writeHead(200, {
        'content-type':recording.type, 'content-length':recording.data.length, 'cache-control':'private, no-store',
        'x-content-type-options':'nosniff', 'content-disposition':'inline',
      })
      ctx.res.end(recording.data)
    }],
    ['POST', /^\/api\/questions\/(\d+)\/answer$/, async (ctx, id) => {
      const coach = requireUser(ctx, 'coach')
      const question = store.getQuestion(Number(id))
      if (!canSeeQuestion(coach, question)) throw new HttpError(404, 'Question not found.')
      return { question:store.answerQuestion(question.id, coach.id, validateAnswer(await readJson(ctx.req))) }
    }],
    // Every unanswered question to this coach, oldest first.
    ['GET', /^\/api\/coach\/questions$/, ctx => {
      const coach = requireUser(ctx, 'coach')
      return { questions:store.openQuestionsOfCoach(coach.id, OPEN_QUESTIONS_MAX) }
    }],
    ['GET', /^\/api\/patients\/(\d+)\/questions$/, (ctx, id) => {
      const patient = requirePatientOf(ctx, numericId(id))
      return store.questionsBetween(patient.id, ctx.user.id, ...pageArgs(ctx.url))
    }],
  ]
  if (devSwitch) {
    routes.push(
      ['GET', /^\/api\/dev\/users$/, () => ({ users:store.listUsers(200) })],
      ['POST', /^\/api\/dev\/switch$/, async ctx => {
        const user = store.userById(numericId(String((await readJson(ctx.req)).userId)))
        if (!user) throw new HttpError(404, 'Account not found.')
        return { user, headers:{ 'set-cookie':signIn(ctx, user.id) } }
      }],
    )
  }

  async function handleApi(req, res, url) {
    const cookies = parseCookies(req.headers.cookie)
    const token = cookies[COOKIE]
    const ctx = { req, res, url, cookies, token, user:store.userForToken(token), ip:req.socket.remoteAddress }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Browsers always send Origin on cross-origin writes; it must name this host.
      // Proxies (Vite in dev, nginx in production) rewrite Host and pass the
      // original in X-Forwarded-Host, which cross-site pages cannot set without
      // a CORS preflight that this server never approves.
      const origin = req.headers.origin
      const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] ?? '').split(',').map(host => host.trim())]
      if (origin && !hosts.includes(new URL(origin).host)) throw new HttpError(403, 'Cross-origin request refused.')
    }
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(url.pathname)
      if (!match || method !== req.method) continue
      const result = await handler(ctx, ...match.slice(1))
      if (res.headersSent) return
      if (Array.isArray(result)) return send(res, result[0], result[1], result[2])
      const { headers, ...body } = result
      return send(res, 200, body, headers)
    }
    throw new HttpError(404, 'Not found.')
  }

  const TYPES = {
    '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml',
    '.png':'image/png', '.wasm':'application/wasm', '.json':'application/json', '.ico':'image/x-icon',
  }
  const SECURITY_HEADERS = {
    'x-content-type-options':'nosniff',
    'referrer-policy':'same-origin',
    'x-frame-options':'DENY',
    // The microphone records video questions to a coach.
    'permissions-policy':'camera=(self), bluetooth=(self), microphone=(self), geolocation=()',
  }
  async function serveStatic(req, res, url) {
    if (!staticDir) throw new HttpError(404, 'Not found.')
    const root = resolve(staticDir)
    let path = resolve(join(root, decodeURIComponent(url.pathname)))
    if (path !== root && !path.startsWith(root + sep)) throw new HttpError(404, 'Not found.')
    let info = await stat(path).catch(() => null)
    if (info?.isDirectory()) { path = join(path, 'index.html'); info = await stat(path).catch(() => null) }
    if (!info) { path = join(root, 'index.html'); info = await stat(path).catch(() => null) }
    if (!info) throw new HttpError(404, 'Not found.')
    const hashed = url.pathname.startsWith('/assets/')
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type':TYPES[extname(path)] ?? 'application/octet-stream',
      'content-length':info.size,
      'cache-control':hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    if (req.method === 'HEAD') return res.end()
    createReadStream(path).pipe(res)
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url)
      else await serveStatic(req, res, url)
    } catch (error) {
      if (res.headersSent) return res.destroy()
      if (error instanceof ValidationError) return send(res, 400, { error:error.message })
      if (error instanceof HttpError) return send(res, error.status, { error:error.message, ...error.details })
      console.error(error)
      send(res, 500, { error:'Something went wrong on the server.' })
    }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const production = process.env.NODE_ENV === 'production'
  const databasePath = process.env.DATABASE_PATH ?? 'data/exercise-tracker.db'
  mkdirSync(dirname(databasePath), { recursive:true })
  const store = openStore(databasePath)
  setInterval(() => store.pruneSessions(), 60 * 60 * 1000).unref()
  const port = Number(process.env.PORT ?? 8787)
  const google = googleConfigFromEnv()
  createApp({ store, staticDir:production ? 'dist' : null, secureCookies:production, google,
    devSwitch:!production && process.env.DEV_ACCOUNT_SWITCH === '1' })
    .listen(port, () => console.log(`API listening on http://localhost:${port}${google ? '' : ' (Sign in with Google off: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set)'}`))
}
