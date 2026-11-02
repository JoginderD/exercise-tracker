import { createServer } from 'node:http'
import { createReadStream, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exercises } from '../src/exercises.js'
import { openStore } from './store.js'
import { ValidationError, validateSession, validateSignup } from './validate.js'

const COOKIE = 'et_session'
const MAX_BODY_BYTES = 512 * 1024
const PAGE_DEFAULT = 25
const PAGE_MAX = 100
const exerciseNames = Object.fromEntries(exercises.map(exercise => [exercise.id, exercise.name]))

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
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
  'partial_reps', 'too_fast_reps', 'too_slow_reps', 'avg_lift_s', 'avg_lower_s']
function csvRow(row) {
  const full = JSON.parse(row.lanes).flatMap(lane => lane.history.filter(rep => rep.kind === 'full'))
  const average = key => {
    const values = full.map(rep => rep[key]).filter(Number.isFinite)
    return values.length ? (values.reduce((a, b) => a + b, 0) / values.length / 1000).toFixed(2) : ''
  }
  return [new Date(row.started_at).toISOString(), exerciseNames[row.exercise] ?? row.exercise, row.source, row.side,
    row.angles, ((row.ended_at - row.started_at) / 1000).toFixed(0), row.reps, row.flagged_reps, row.partial_reps,
    row.fast_reps, row.slow_reps, average('liftMs'), average('lowerMs')].map(csvCell).join(',')
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

export function createApp({ store, staticDir, secureCookies = false } = {}) {
  const loginByIp = createLimiter(30, 15 * 60 * 1000)
  const loginByEmail = createLimiter(10, 15 * 60 * 1000)
  const signupByIp = createLimiter(10, 60 * 60 * 1000)
  const linkByUser = createLimiter(10, 15 * 60 * 1000)
  const saveByUser = createLimiter(600, 60 * 60 * 1000)

  const cookie = (value, maxAge) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`

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
    ['GET', /^\/api\/me$/, ctx => ({ user:ctx.user })],
    ['POST', /^\/api\/signup$/, async ctx => {
      signupByIp.take(ctx.ip)
      const input = validateSignup(await readJson(ctx.req))
      const user = await store.createUser(input)
      if (!user) throw new HttpError(409, 'An account with that email already exists. Sign in instead.')
      const session = store.startSession(user.id)
      return [201, { user }, { 'set-cookie':cookie(session.token, session.maxAge) }]
    }],
    ['POST', /^\/api\/login$/, async ctx => {
      const body = await readJson(ctx.req)
      loginByIp.take(ctx.ip)
      loginByEmail.take(String(body.email ?? '').trim().toLowerCase())
      const user = await store.checkLogin(body.email, body.password)
      if (!user) throw new HttpError(401, 'Email or password is incorrect.')
      const session = store.startSession(user.id)
      return { user, headers:{ 'set-cookie':cookie(session.token, session.maxAge) } }
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
      return { session:rest }
    }],

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
    ['GET', /^\/api\/patients$/, ctx => ({ patients:store.patientsOf(requireUser(ctx, 'coach').id) })],
    ['GET', /^\/api\/patients\/(\d+)\/sessions$/, (ctx, id) => {
      const patient = requirePatientOf(ctx, numericId(id))
      return { patient, ...store.listSessions(patient.id, ...pageArgs(ctx.url)) }
    }],
    ['GET', /^\/api\/patients\/(\d+)\/sessions\.csv$/, (ctx, id) => {
      const patient = requirePatientOf(ctx, numericId(id))
      sendCsv(ctx.res, store.iterateSessions(patient.id), `${patient.name}-exercise-sessions.csv`)
    }],
  ]

  async function handleApi(req, res, url) {
    const token = parseCookies(req.headers.cookie)[COOKIE]
    const ctx = { req, res, url, token, user:store.userForToken(token), ip:req.socket.remoteAddress }
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
    'permissions-policy':'camera=(self), microphone=(), geolocation=()',
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
      if (error instanceof HttpError) return send(res, error.status, { error:error.message })
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
  createApp({ store, staticDir:production ? 'dist' : null, secureCookies:production })
    .listen(port, () => console.log(`API listening on http://localhost:${port}`))
}
