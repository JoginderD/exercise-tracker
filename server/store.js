import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

// Applied in order and recorded in user_version. Never edit an applied entry;
// append a new one instead.
const MIGRATIONS = [
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('patient', 'coach')),
    password_hash TEXT NOT NULL,
    coach_code TEXT UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
  CREATE TABLE coach_links (
    patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coach_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (patient_id, coach_id)
  );
  CREATE INDEX coach_links_coach ON coach_links(coach_id);
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    exercise TEXT NOT NULL,
    source TEXT NOT NULL,
    side TEXT NOT NULL,
    angles TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    reps INTEGER NOT NULL,
    flagged_reps INTEGER NOT NULL,
    partial_reps INTEGER NOT NULL,
    fast_reps INTEGER NOT NULL,
    slow_reps INTEGER NOT NULL,
    lanes TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, client_id)
  );
  CREATE INDEX sessions_user_time ON sessions(user_id, started_at DESC, id DESC);`,
]

const SESSION_DAYS = 30
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const sha256 = text => createHash('sha256').update(text).digest('hex')

export function newCoachCode() {
  let code = ''
  for (let i = 0; i < 10; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}
// Accepts the code however it was typed: lower case, spaces or the display dash.
export const normaliseCode = code => typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : ''
export const formatCode = code => code && `${code.slice(0, 5)}-${code.slice(5)}`

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}
export async function verifyPassword(password, stored) {
  const [, salt, expected] = stored.split('$')
  const hash = await scryptAsync(password, Buffer.from(salt, 'base64'), 64)
  return timingSafeEqual(hash, Buffer.from(expected, 'base64'))
}
// Compared against when the email is unknown, so a miss takes as long as a wrong password.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'))

const publicUser = row => row && {
  id:row.id, email:row.email, name:row.name, role:row.role,
  coachCode:row.role === 'coach' ? formatCode(row.coach_code) : undefined,
}

function sessionSummary(row) {
  return {
    id:row.id, exercise:row.exercise, source:row.source, side:row.side, angles:row.angles,
    startedAt:row.started_at, endedAt:row.ended_at,
    reps:row.reps, flaggedReps:row.flagged_reps, partialReps:row.partial_reps,
    fastReps:row.fast_reps, slowReps:row.slow_reps,
  }
}
// Newest first, paged by (started_at, id) so inserts between pages never skip or repeat rows.
const encodeCursor = row => `${row.started_at}_${row.id}`
function decodeCursor(cursor) {
  const match = /^(\d+)_(\d+)$/.exec(cursor ?? '')
  return match ? [Number(match[1]), Number(match[2])] : [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
}

export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const version = db.prepare('PRAGMA user_version').get().user_version
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[i])
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const q = {
    userByEmail:db.prepare('SELECT * FROM users WHERE email = ?'),
    userById:db.prepare('SELECT * FROM users WHERE id = ?'),
    coachByCode:db.prepare(`SELECT * FROM users WHERE coach_code = ? AND role = 'coach'`),
    insertUser:db.prepare(`INSERT INTO users (email, name, role, password_hash, coach_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING *`),
    setCoachCode:db.prepare('UPDATE users SET coach_code = ? WHERE id = ?'),
    insertAuth:db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    userByToken:db.prepare(`SELECT users.* FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
      WHERE token_hash = ? AND expires_at > ?`),
    deleteAuth:db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?'),
    deleteExpired:db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?'),
    insertSession:db.prepare(`INSERT INTO sessions (user_id, client_id, exercise, source, side, angles, started_at, ended_at,
      reps, flagged_reps, partial_reps, fast_reps, slow_reps, lanes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, client_id) DO NOTHING RETURNING id`),
    sessionByClientId:db.prepare('SELECT id FROM sessions WHERE user_id = ? AND client_id = ?'),
    sessionPage:db.prepare(`SELECT * FROM sessions WHERE user_id = ? AND (started_at, id) < (?, ?)
      ORDER BY started_at DESC, id DESC LIMIT ?`),
    allSessions:db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC, id DESC'),
    sessionById:db.prepare('SELECT * FROM sessions WHERE id = ?'),
    link:db.prepare(`INSERT INTO coach_links (patient_id, coach_id, created_at) VALUES (?, ?, ?)
      ON CONFLICT DO NOTHING`),
    restoreLink:db.prepare(`INSERT INTO coach_links (patient_id, coach_id, created_at)
      SELECT ?, id, ? FROM users WHERE id = ? AND role = 'coach' ON CONFLICT DO NOTHING`),
    unlink:db.prepare('DELETE FROM coach_links WHERE patient_id = ? AND coach_id = ?'),
    isLinked:db.prepare('SELECT 1 FROM coach_links WHERE patient_id = ? AND coach_id = ?'),
    coachesOf:db.prepare(`SELECT users.id, users.name, users.email, coach_links.created_at AS linked_at
      FROM coach_links JOIN users ON users.id = coach_links.coach_id
      WHERE coach_links.patient_id = ? ORDER BY users.name`),
    // One aggregate query for the whole roster rather than one per patient.
    patientsOf:db.prepare(`SELECT users.id, users.name, users.email, coach_links.created_at AS linked_at,
        COUNT(sessions.id) AS session_count, MAX(sessions.started_at) AS last_session_at,
        COALESCE(SUM(sessions.reps), 0) AS total_reps
      FROM coach_links JOIN users ON users.id = coach_links.patient_id
      LEFT JOIN sessions ON sessions.user_id = users.id
      WHERE coach_links.coach_id = ? GROUP BY users.id ORDER BY last_session_at IS NULL, last_session_at DESC, users.name`),
  }

  // Collisions in a 32^10 space are vanishingly rare, but the UNIQUE index decides.
  function withFreshCode(write) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return write(newCoachCode()) }
      catch (error) { if (!String(error.message).includes('coach_code')) throw error }
    }
    throw new Error('Could not allocate a coach code')
  }

  return {
    db,
    async createUser({ email, name, password, role }) {
      const hash = await hashPassword(password)
      try {
        const row = role === 'coach'
          ? withFreshCode(code => q.insertUser.get(email, name, role, hash, code, Date.now()))
          : q.insertUser.get(email, name, role, hash, null, Date.now())
        return publicUser(row)
      } catch (error) {
        if (String(error.message).includes('users.email')) return null
        throw error
      }
    },
    async checkLogin(email, password) {
      const row = q.userByEmail.get(String(email ?? '').trim().toLowerCase())
      const ok = await verifyPassword(String(password ?? ''), row?.password_hash ?? DUMMY_HASH)
      return ok && row ? publicUser(row) : null
    },
    startSession(userId) {
      const token = randomBytes(32).toString('base64url')
      const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
      q.insertAuth.run(sha256(token), userId, expires)
      return { token, maxAge:SESSION_DAYS * 24 * 60 * 60 }
    },
    userForToken(token) {
      return token ? publicUser(q.userByToken.get(sha256(token), Date.now())) : null
    },
    endSession(token) {
      if (token) q.deleteAuth.run(sha256(token))
    },
    pruneSessions() {
      q.deleteExpired.run(Date.now())
    },
    rotateCoachCode(userId) {
      withFreshCode(code => q.setCoachCode.run(code, userId))
      return publicUser(q.userById.get(userId))
    },

    // Idempotent on the client's id, so retries and double-sends store one row.
    saveSession(userId, session) {
      const totals = key => session.lanes.reduce((sum, lane) => sum + lane[key], 0)
      const row = q.insertSession.get(userId, session.id, session.exercise, session.source, session.side, session.angles,
        session.startedAt, session.endedAt, totals('reps'), totals('flaggedReps'), totals('partialReps'),
        totals('fastReps'), totals('slowReps'), JSON.stringify(session.lanes), Date.now())
      return row ? { id:row.id, duplicate:false } : { id:q.sessionByClientId.get(userId, session.id).id, duplicate:true }
    },
    listSessions(userId, cursor, limit) {
      const rows = q.sessionPage.all(userId, ...decodeCursor(cursor), limit + 1)
      const page = rows.slice(0, limit)
      return { sessions:page.map(sessionSummary), next:rows.length > limit ? encodeCursor(page.at(-1)) : null }
    },
    iterateSessions(userId) {
      return q.allSessions.iterate(userId)
    },
    getSession(id) {
      const row = q.sessionById.get(id)
      return row && { ...sessionSummary(row), userId:row.user_id, lanes:JSON.parse(row.lanes) }
    },

    linkCoach(patientId, code) {
      const coach = q.coachByCode.get(normaliseCode(code))
      if (!coach) return null
      q.link.run(patientId, coach.id, Date.now())
      return { id:coach.id, name:coach.name, email:coach.email }
    },
    restoreLink(patientId, coachId, linkedAt) {
      q.restoreLink.run(patientId, linkedAt, coachId)
    },
    unlinkCoach(patientId, coachId) {
      return q.unlink.run(patientId, coachId).changes > 0
    },
    isLinked(patientId, coachId) {
      return Boolean(q.isLinked.get(patientId, coachId))
    },
    coachesOf(patientId) {
      return q.coachesOf.all(patientId).map(row => ({ id:row.id, name:row.name, email:row.email, linkedAt:row.linked_at }))
    },
    patientsOf(coachId) {
      return q.patientsOf.all(coachId).map(row => ({
        id:row.id, name:row.name, email:row.email, linkedAt:row.linked_at,
        sessionCount:row.session_count, lastSessionAt:row.last_session_at, totalReps:row.total_reps,
      }))
    },
    userById(id) {
      return publicUser(q.userById.get(id))
    },
    close() { db.close() },
  }
}
