import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { summariseImu } from '../src/vbt.js'

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
  // Dumbbell sensor reps as JSON (see validate.js), null for camera-only sessions.
  `ALTER TABLE sessions ADD COLUMN imu TEXT;`,
  // Safety alerts as JSON [{ kind, at }] (see validate.js), null when there were none.
  `ALTER TABLE sessions ADD COLUMN safety TEXT;`,
  // Google account id (the ID token's "sub") for Sign in with Google. Accounts created
  // with Google alone have an empty password_hash, which no password matches.
  `ALTER TABLE users ADD COLUMN google_sub TEXT;
  CREATE UNIQUE INDEX users_google_sub ON users(google_sub);`,
  // Short videos around flagged moments, uploaded only while the patient has
  // share_clips on. labels is JSON [{ kind, lane, rep, text, at }] (see validate.js).
  `ALTER TABLE users ADD COLUMN share_clips INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE clips (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    labels TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (session_id, client_id)
  );`,
  // A coach's exercise plan for one patient, as JSON rows (see src/plan.js). version
  // rises on every save, so an edit made from a stale copy is refused, not merged.
  // Questions from a patient to one of their coaches, typed or recorded; an unanswered
  // question puts the patient first on the coach's roster. The audio columns hold the
  // recording, which is a video with sound (or, for early questions, sound alone).
  `CREATE TABLE plans (
    patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coach_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    items TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (patient_id, coach_id)
  );
  CREATE TABLE questions (
    id INTEGER PRIMARY KEY,
    patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coach_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    body TEXT NOT NULL,
    audio BLOB,
    audio_type TEXT,
    audio_ms INTEGER,
    created_at INTEGER NOT NULL,
    answer TEXT,
    answered_at INTEGER,
    UNIQUE (patient_id, client_id)
  );
  CREATE INDEX questions_patient ON questions(patient_id, id DESC);
  CREATE INDEX questions_open ON questions(coach_id, created_at) WHERE answered_at IS NULL;`,
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
  shareClips:row.role === 'patient' ? row.share_clips === 1 : undefined,
}
// Clip details without the video bytes, which are fetched one clip at a time.
const clipSummary = row => ({
  id:row.id, labels:JSON.parse(row.labels), startedAt:row.started_at, durationMs:row.duration_ms, type:row.type, size:row.size,
})
export const MAX_CLIPS_PER_SESSION = 20

// Without the recording's bytes, which are fetched one question at a time.
const questionSummary = row => ({
  id:row.id, patientId:row.patient_id, coachId:row.coach_id, text:row.body,
  recording:row.audio_type ? { type:row.audio_type, durationMs:row.audio_ms } : null,
  createdAt:row.created_at, answer:row.answer, answeredAt:row.answered_at,
  ...row.patient_name === undefined ? {} : { patientName:row.patient_name },
  ...row.coach_name === undefined ? {} : { coachName:row.coach_name },
})
const QUESTION_COLUMNS = `questions.id, questions.patient_id, questions.coach_id, questions.body, questions.audio_type,
  questions.audio_ms, questions.created_at, questions.answer, questions.answered_at`

function sessionSummary(row) {
  return {
    id:row.id, exercise:row.exercise, source:row.source, side:row.side, angles:row.angles,
    startedAt:row.started_at, endedAt:row.ended_at,
    reps:row.reps, flaggedReps:row.flagged_reps, partialReps:row.partial_reps,
    fastReps:row.fast_reps, slowReps:row.slow_reps,
    sensor:row.imu ? summariseImu(JSON.parse(row.imu)) : null,
    safetyAlerts:row.safety ? JSON.parse(row.safety).length : 0,
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
    // Development account switcher only (see devSwitch in index.js).
    setShareClips:db.prepare(`UPDATE users SET share_clips = ? WHERE id = ? AND role = 'patient'`),
    insertClip:db.prepare(`INSERT INTO clips (session_id, client_id, labels, started_at, duration_ms, type, size, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session_id, client_id) DO NOTHING RETURNING id`),
    clipByClientId:db.prepare('SELECT id FROM clips WHERE session_id = ? AND client_id = ?'),
    clipCount:db.prepare('SELECT COUNT(*) AS count FROM clips WHERE session_id = ?'),
    clipsOfSession:db.prepare(`SELECT id, labels, started_at, duration_ms, type, size FROM clips
      WHERE session_id = ? ORDER BY started_at, id`),
    clipById:db.prepare(`SELECT clips.id, clips.type, clips.data, sessions.user_id, users.share_clips FROM clips
      JOIN sessions ON sessions.id = clips.session_id JOIN users ON users.id = sessions.user_id WHERE clips.id = ?`),
    deleteClip:db.prepare(`DELETE FROM clips WHERE id = ? AND session_id IN (SELECT id FROM sessions WHERE user_id = ?)`),
    // Bounded by time, and by a row cap as a backstop, so a coach with many busy patients stays cheap.
    recentOfCoach:db.prepare(`SELECT sessions.user_id, sessions.started_at, sessions.reps, sessions.flagged_reps,
        sessions.safety IS NOT NULL AS has_safety
      FROM coach_links JOIN sessions ON sessions.user_id = coach_links.patient_id
      WHERE coach_links.coach_id = ? AND sessions.started_at >= ? ORDER BY sessions.started_at DESC LIMIT 20000`),
    progress:db.prepare(`SELECT started_at, reps, flagged_reps, partial_reps, fast_reps, slow_reps FROM sessions
      WHERE user_id = ? AND started_at >= ? ORDER BY started_at LIMIT 5000`),
    listUsers:db.prepare('SELECT * FROM users ORDER BY role, name, id LIMIT ?'),
    coachByCode:db.prepare(`SELECT * FROM users WHERE coach_code = ? AND role = 'coach'`),
    insertUser:db.prepare(`INSERT INTO users (email, name, role, password_hash, coach_code, google_sub, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`),
    userByGoogleSub:db.prepare('SELECT * FROM users WHERE google_sub = ?'),
    linkGoogle:db.prepare('UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL'),
    setCoachCode:db.prepare('UPDATE users SET coach_code = ? WHERE id = ?'),
    insertAuth:db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    userByToken:db.prepare(`SELECT users.* FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
      WHERE token_hash = ? AND expires_at > ?`),
    deleteAuth:db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?'),
    deleteExpired:db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?'),
    insertSession:db.prepare(`INSERT INTO sessions (user_id, client_id, exercise, source, side, angles, started_at, ended_at,
      reps, flagged_reps, partial_reps, fast_reps, slow_reps, lanes, imu, safety, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        COALESCE(SUM(sessions.reps), 0) AS total_reps, COUNT(sessions.safety) AS safety_sessions
      FROM coach_links JOIN users ON users.id = coach_links.patient_id
      LEFT JOIN sessions ON sessions.user_id = users.id
      WHERE coach_links.coach_id = ? GROUP BY users.id ORDER BY last_session_at IS NULL, last_session_at DESC, users.name`),
    // Unanswered questions per patient, for the roster's "needs a look".
    openQuestionCounts:db.prepare(`SELECT patient_id, COUNT(*) AS count, MIN(created_at) AS oldest_at FROM questions
      WHERE coach_id = ? AND answered_at IS NULL GROUP BY patient_id`),

    plan:db.prepare('SELECT items, version, updated_at FROM plans WHERE patient_id = ? AND coach_id = ?'),
    // Inserts version 1, or bumps the version only if the caller saw the current one.
    savePlan:db.prepare(`INSERT INTO plans (patient_id, coach_id, items, version, updated_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (patient_id, coach_id) DO UPDATE SET items = excluded.items, version = plans.version + 1, updated_at = excluded.updated_at
      WHERE plans.version = ? RETURNING items, version, updated_at`),
    // Plans of coaches the patient still shares with.
    plansOfPatient:db.prepare(`SELECT plans.items, plans.version, plans.updated_at, users.id AS coach_id, users.name AS coach_name
      FROM plans JOIN coach_links ON coach_links.patient_id = plans.patient_id AND coach_links.coach_id = plans.coach_id
      JOIN users ON users.id = plans.coach_id WHERE plans.patient_id = ? ORDER BY users.name`),
    weekSessions:db.prepare(`SELECT exercise, started_at, reps FROM sessions WHERE user_id = ? AND started_at >= ? AND started_at < ?
      ORDER BY started_at DESC LIMIT 5000`),

    insertQuestion:db.prepare(`INSERT INTO questions (patient_id, coach_id, client_id, body, audio, audio_type, audio_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (patient_id, client_id) DO NOTHING RETURNING id`),
    questionByClientId:db.prepare('SELECT id FROM questions WHERE patient_id = ? AND client_id = ?'),
    questionById:db.prepare(`SELECT ${QUESTION_COLUMNS}, patient.name AS patient_name, coach.name AS coach_name FROM questions
      JOIN users AS patient ON patient.id = questions.patient_id JOIN users AS coach ON coach.id = questions.coach_id
      WHERE questions.id = ?`),
    questionRecording:db.prepare('SELECT patient_id, coach_id, audio, audio_type FROM questions WHERE id = ? AND audio IS NOT NULL'),
    // Newest first, paged by id, which only grows.
    questionsOfPatient:db.prepare(`SELECT ${QUESTION_COLUMNS}, users.name AS coach_name FROM questions
      JOIN users ON users.id = questions.coach_id WHERE questions.patient_id = ? AND questions.id < ? ORDER BY questions.id DESC LIMIT ?`),
    questionsBetween:db.prepare(`SELECT ${QUESTION_COLUMNS} FROM questions
      WHERE patient_id = ? AND coach_id = ? AND id < ? ORDER BY id DESC LIMIT ?`),
    // Oldest waiting first, from patients still sharing with this coach.
    openQuestionsOfCoach:db.prepare(`SELECT ${QUESTION_COLUMNS}, users.name AS patient_name FROM questions
      JOIN coach_links ON coach_links.patient_id = questions.patient_id AND coach_links.coach_id = questions.coach_id
      JOIN users ON users.id = questions.patient_id
      WHERE questions.coach_id = ? AND questions.answered_at IS NULL ORDER BY questions.created_at, questions.id LIMIT ?`),
    answerQuestion:db.prepare('UPDATE questions SET answer = ?, answered_at = ? WHERE id = ? AND coach_id = ?'),
  }
  const planRow = row => ({ items:JSON.parse(row.items), version:row.version, updatedAt:row.updated_at })
  function questionPage(rows, limit) {
    const page = rows.slice(0, limit)
    return { questions:page.map(questionSummary), next:rows.length > limit ? String(page.at(-1).id) : null }
  }
  const pageCursor = before => /^\d{1,15}$/.test(before ?? '') ? Number(before) : Number.MAX_SAFE_INTEGER

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
    // password is null for an account created with Google.
    async createUser({ email, name, password, role, googleSub = null }) {
      const hash = password === null ? '' : await hashPassword(password)
      try {
        const row = role === 'coach'
          ? withFreshCode(code => q.insertUser.get(email, name, role, hash, code, googleSub, Date.now()))
          : q.insertUser.get(email, name, role, hash, null, googleSub, Date.now())
        return publicUser(row)
      } catch (error) {
        if (/users\.(email|google_sub)/.test(error.message)) return null
        throw error
      }
    },
    async checkLogin(email, password) {
      const row = q.userByEmail.get(String(email ?? '').trim().toLowerCase())
      // Google-only accounts have no password, so they take the same path as an unknown email.
      const ok = await verifyPassword(String(password ?? ''), row?.password_hash || DUMMY_HASH)
      return ok && row?.password_hash ? publicUser(row) : null
    },
    userByGoogleSub(sub) {
      return publicUser(q.userByGoogleSub.get(sub))
    },
    // null when no account uses this email; otherwise whether it is already tied to a Google account.
    emailAccount(email) {
      const row = q.userByEmail.get(email)
      return row ? { id:row.id, googleSub:row.google_sub } : null
    },
    // Ties a Google account to an existing user. False if either side is already tied.
    linkGoogle(userId, sub) {
      try { return q.linkGoogle.run(sub, userId).changes > 0 }
      catch (error) {
        if (String(error.message).includes('google_sub')) return false
        throw error
      }
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
        totals('fastReps'), totals('slowReps'), JSON.stringify(session.lanes), session.imu ? JSON.stringify(session.imu) : null,
        session.safety?.length ? JSON.stringify(session.safety) : null, Date.now())
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
      return row && { ...sessionSummary(row), userId:row.user_id, lanes:JSON.parse(row.lanes), imu:row.imu ? JSON.parse(row.imu) : null,
        safety:row.safety ? JSON.parse(row.safety) : [], clips:q.clipsOfSession.all(row.id).map(clipSummary) }
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
        safetySessions:row.safety_sessions,
      }))
    },
    userById(id) {
      return publicUser(q.userById.get(id))
    },
    setShareClips(userId, on) {
      q.setShareClips.run(on ? 1 : 0, userId)
      return publicUser(q.userById.get(userId))
    },
    // null when the session has not been uploaded yet (the client retries after it is),
    // 'full' when the session already has its maximum number of clips.
    saveClip(userId, sessionClientId, clip) {
      const session = q.sessionByClientId.get(userId, sessionClientId)
      if (!session) return null
      const existing = q.clipByClientId.get(session.id, clip.id)
      if (existing) return { id:existing.id, duplicate:true }
      if (q.clipCount.get(session.id).count >= MAX_CLIPS_PER_SESSION) return 'full'
      const row = q.insertClip.get(session.id, clip.id, JSON.stringify(clip.labels), clip.startedAt, clip.durationMs,
        clip.type, clip.data.length, clip.data, Date.now())
      return row ? { id:row.id, duplicate:false } : { id:q.clipByClientId.get(session.id, clip.id).id, duplicate:true }
    },
    // Includes the owner and their sharing setting so the caller can check access.
    getClip(id) {
      const row = q.clipById.get(id)
      return row && { id:row.id, type:row.type, data:row.data, userId:row.user_id, shareClips:row.share_clips === 1 }
    },
    deleteClip(id, userId) {
      return q.deleteClip.run(id, userId).changes > 0
    },
    recentSessionsOfCoach(coachId, since) {
      return q.recentOfCoach.all(coachId, since).map(row => ({
        userId:row.user_id, startedAt:row.started_at, reps:row.reps, flaggedReps:row.flagged_reps, safety:row.has_safety === 1,
      }))
    },
    progress(userId, since) {
      return q.progress.all(userId, since).map(row => ({
        startedAt:row.started_at, reps:row.reps, flaggedReps:row.flagged_reps, partialReps:row.partial_reps,
        fastReps:row.fast_reps, slowReps:row.slow_reps,
      }))
    },
    listUsers(limit) {
      return q.listUsers.all(limit).map(publicUser)
    },

    // { items:[], version:0 } before the coach saves a first plan.
    plan(patientId, coachId) {
      const row = q.plan.get(patientId, coachId)
      return row ? planRow(row) : { items:[], version:0, updatedAt:null }
    },
    // null when version is not the current one (someone saved in between).
    savePlan(patientId, coachId, items, version) {
      const row = q.savePlan.get(patientId, coachId, JSON.stringify(items), Date.now(), version)
      return row ? planRow(row) : null
    },
    plansOfPatient(patientId) {
      return q.plansOfPatient.all(patientId).map(row => ({ ...planRow(row), coach:{ id:row.coach_id, name:row.coach_name } }))
    },
    weekSessions(userId, from, to) {
      return q.weekSessions.all(userId, from, to).map(row => ({ exercise:row.exercise, startedAt:row.started_at, reps:row.reps }))
    },

    // Idempotent on the client's id, so a double-click or a retry stores one question.
    saveQuestion(patientId, question) {
      const row = q.insertQuestion.get(patientId, question.coachId, question.id, question.text, question.recording?.data ?? null,
        question.recording?.type ?? null, question.recording?.durationMs ?? null, Date.now())
      const id = row ? row.id : q.questionByClientId.get(patientId, question.id).id
      return { question:questionSummary(q.questionById.get(id)), duplicate:!row }
    },
    getQuestion(id) {
      const row = q.questionById.get(id)
      return row ? questionSummary(row) : null
    },
    questionRecording(id) {
      const row = q.questionRecording.get(id)
      return row && { patientId:row.patient_id, coachId:row.coach_id, data:row.audio, type:row.audio_type }
    },
    questionsOfPatient(patientId, before, limit) {
      return questionPage(q.questionsOfPatient.all(patientId, pageCursor(before), limit + 1), limit)
    },
    questionsBetween(patientId, coachId, before, limit) {
      return questionPage(q.questionsBetween.all(patientId, coachId, pageCursor(before), limit + 1), limit)
    },
    openQuestionsOfCoach(coachId, limit) {
      return q.openQuestionsOfCoach.all(coachId, limit).map(questionSummary)
    },
    openQuestionCounts(coachId) {
      return new Map(q.openQuestionCounts.all(coachId).map(row => [row.patient_id, { count:row.count, oldestAt:row.oldest_at }]))
    },
    answerQuestion(id, coachId, answer) {
      q.answerQuestion.run(answer, Date.now(), id, coachId)
      return questionSummary(q.questionById.get(id))
    },
    close() { db.close() },
  }
}
