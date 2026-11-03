import { exercises } from '../src/exercises.js'
import { SAFETY_KINDS } from '../src/safety.js'
import { PLAN_LIMITS, planItem } from '../src/plan.js'

// Everything here comes from the browser, so each field is checked and copied
// across explicitly: unknown fields are dropped, and sizes are capped so one
// request cannot store an unbounded blob.
const EXERCISE_IDS = new Set(exercises.map(exercise => exercise.id))
const MAX_REPS_PER_LANE = 2000
const MAX_SAFETY_ALERTS = 200
const MAX_SESSION_MS = 6 * 60 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000
const EARLIEST = Date.UTC(2024, 0, 1)

export class ValidationError extends Error {}

const fail = message => { throw new ValidationError(message) }
const oneOf = (value, options, name) => options.includes(value) ? value : fail(`${name} must be one of ${options.join(', ')}`)
function count(value, name, max = 100000) {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : fail(`${name} must be a whole number from 0 to ${max}`)
}
function optionalMs(value, name) {
  if (value === null || value === undefined) return null
  return Number.isFinite(value) && value >= 0 && value <= MAX_SESSION_MS ? Math.round(value) : fail(`${name} is out of range`)
}
function messages(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 5) fail('messages must be a list of at most 5')
  return value.map(message => typeof message === 'string' && message.length <= 200 ? message : fail('message too long'))
}

function rep(value, index) {
  if (!value || typeof value !== 'object') fail(`rep ${index} is not an object`)
  if (value.kind === 'partial') {
    return {
      kind:'partial',
      missed:oneOf(value.missed, ['target', 'start'], 'missed'),
      reached:Number.isFinite(value.reached) && Math.abs(value.reached) <= 360 ? Math.round(value.reached) : null,
      messages:messages(value.messages),
    }
  }
  if (value.kind !== 'full') fail(`rep ${index} kind must be full or partial`)
  return {
    kind:'full',
    number:count(value.number, 'rep number', MAX_REPS_PER_LANE),
    liftMs:optionalMs(value.liftMs, 'liftMs'),
    lowerMs:optionalMs(value.lowerMs, 'lowerMs'),
    tempo:value.tempo === null || value.tempo === undefined ? null : oneOf(value.tempo, ['good', 'fast', 'slow'], 'tempo'),
    flagged:value.flagged === true,
    messages:messages(value.messages),
  }
}

function measure(value, name, max, places, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null
  return Number.isFinite(value) && value >= 0 && value <= max ? Number(value.toFixed(places)) : fail(`${name} is out of range`)
}
function shortText(value, max) {
  return typeof value === 'string' && value.length <= max ? value : null
}

// The dumbbell sensor's reps (src/vbt.js). Totals are derived from these on read, so
// nothing stored can disagree with the reps behind it.
function sensorRep(value, index) {
  if (!value || typeof value !== 'object') fail(`sensor rep ${index} is not an object`)
  return {
    number:count(value.number, 'sensor rep number', MAX_REPS_PER_LANE),
    set:value.set === undefined ? 1 : count(value.set, 'set number', MAX_REPS_PER_LANE),
    mcv:measure(value.mcv, 'mean velocity', 10, 3),
    peakVelocity:measure(value.peakVelocity, 'peak velocity', 20, 3),
    romCm:measure(value.romCm, 'range of motion', 300, 1),
    concentricMs:Math.round(measure(value.concentricMs, 'lift time', 60000, 0)),
    eccentricMs:optionalMs(value.eccentricMs, 'lowering time'),
    meanPowerW:measure(value.meanPowerW, 'mean power', 20000, 1, true),
    peakPowerW:measure(value.peakPowerW, 'peak power', 50000, 1, true),
    rotationDeg:measure(value.rotationDeg, 'rotation', 360, 1),
    peakGyroDps:measure(value.peakGyroDps, 'angular speed', 5000, 1),
    velocityLossPct:measure(value.velocityLossPct, 'velocity loss', 100, 1),
  }
}

function imu(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') fail('imu must be an object')
  if (!Array.isArray(value.reps) || value.reps.length < 1 || value.reps.length > MAX_REPS_PER_LANE) fail('imu reps are missing or too many')
  const massKg = value.massKg === null || value.massKg === undefined ? null
    : Number.isFinite(value.massKg) && value.massKg >= 0.5 && value.massKg <= 200 ? value.massKg : fail('massKg must be 0.5 to 200')
  return {
    sensor:{ name:shortText(value.sensor?.name, 40), firmware:shortText(value.sensor?.firmware, 20) },
    hand:value.hand === null || value.hand === undefined ? null : oneOf(value.hand, ['left', 'right'], 'hand'),
    massKg,
    lossThresholdPct:count(value.lossThresholdPct, 'lossThresholdPct', 100),
    interruptions:count(value.interruptions, 'interruptions', 100000),
    reps:value.reps.map(sensorRep),
  }
}

// Safety alerts raised during the run, each timed within the session (a minute of slack
// either side, as the alert can fire just before the first tracked frame).
function safety(value, startedAt, endedAt) {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_SAFETY_ALERTS) fail(`safety must be a list of at most ${MAX_SAFETY_ALERTS}`)
  return value.map(alert => {
    if (!alert || typeof alert !== 'object') fail('safety alert is not an object')
    const at = Number.isFinite(alert.at) && alert.at >= startedAt - 60000 && alert.at <= endedAt + 60000
      ? Math.round(alert.at) : fail('safety alert time is out of range')
    return { kind:oneOf(alert.kind, SAFETY_KINDS, 'safety kind'), at }
  })
}

function lane(value) {
  if (!value || typeof value !== 'object') fail('lane is not an object')
  if (!Array.isArray(value.history) || value.history.length > MAX_REPS_PER_LANE * 2) fail('history is missing or too long')
  const result = {
    side:oneOf(value.side, ['left', 'right', 'auto'], 'lane side'),
    reps:count(value.reps, 'reps', MAX_REPS_PER_LANE),
    flaggedReps:count(value.flaggedReps, 'flaggedReps', MAX_REPS_PER_LANE),
    partialReps:count(value.partialReps, 'partialReps', MAX_REPS_PER_LANE * 2),
    fastReps:count(value.fastReps, 'fastReps', MAX_REPS_PER_LANE),
    slowReps:count(value.slowReps, 'slowReps', MAX_REPS_PER_LANE),
    history:value.history.map(rep),
  }
  if (result.flaggedReps > result.reps || result.fastReps + result.slowReps > result.reps) fail('rep totals do not add up')
  return result
}

// Returns a clean session record, or throws ValidationError with a readable reason.
export function validateSession(body, now = Date.now()) {
  if (!body || typeof body !== 'object') fail('Body must be a JSON object')
  if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id)) fail('id must be a UUID')
  if (!EXERCISE_IDS.has(body.exercise)) fail('Unknown exercise')
  const { startedAt, endedAt } = body
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) fail('startedAt and endedAt are required')
  if (startedAt < EARLIEST || endedAt > now + MAX_CLOCK_SKEW_MS) fail('Session time is out of range')
  if (endedAt < startedAt || endedAt - startedAt > MAX_SESSION_MS) fail('Session duration is out of range')
  if (!Array.isArray(body.lanes) || body.lanes.length < 1 || body.lanes.length > 2) fail('lanes must hold one or two entries')
  return {
    id:body.id.toLowerCase(),
    exercise:body.exercise,
    source:oneOf(body.source, ['camera', 'video'], 'source'),
    side:oneOf(body.side, ['left', 'right', 'auto', 'each'], 'side'),
    angles:oneOf(body.angles, ['3d', '2d'], 'angles'),
    startedAt:Math.round(startedAt),
    endedAt:Math.round(endedAt),
    lanes:body.lanes.map(lane),
    imu:imu(body.imu),
    safety:safety(body.safety, startedAt, endedAt),
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Name and role, asked of every new account; the email comes from the form or from Google.
export function validateProfile(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 100) fail('Enter your name (up to 100 characters).')
  return { name, role:oneOf(body.role, ['patient', 'coach'], 'role') }
}

export function validateSignup(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!EMAIL.test(email) || email.length > 254) fail('Enter a valid email address.')
  const { name, role } = validateProfile(body)
  if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 200) {
    fail('Password must be 10 to 200 characters.')
  }
  return { email, name, password:body.password, role }
}

// A clip's details arrive in a header (the body is the video), so they are capped tightly.
export const MAX_CLIP_BYTES = 6 * 1024 * 1024
const MAX_CLIP_MS = 25 * 1000
const MAX_CLIP_LABELS = 20
const CLIP_TYPES = ['video/mp4', 'video/webm']
const UUID = /^[0-9a-f-]{36}$/i
function clipLabel(value) {
  if (!value || typeof value !== 'object') fail('clip label is not an object')
  return {
    kind:oneOf(value.kind, ['form', 'safety', 'tempo'], 'clip label kind'),
    lane:value.lane === null || value.lane === undefined ? null : oneOf(value.lane, ['left', 'right', 'auto'], 'clip lane'),
    rep:value.rep === null || value.rep === undefined ? null : count(value.rep, 'clip rep', MAX_REPS_PER_LANE),
    text:typeof value.text === 'string' && value.text.length <= 200 ? value.text : fail('clip label text too long'),
    at:Number.isFinite(value.at) && value.at >= EARLIEST ? Math.round(value.at) : fail('clip label time is out of range'),
  }
}
// The bytes must look like the container they claim to be, so nothing else is
// stored and later served as video.
function looksLike(type, data) {
  if (type === 'video/mp4') return data.length > 12 && data.toString('latin1', 4, 8) === 'ftyp'
  return data.length > 4 && data.readUInt32BE(0) === 0x1a45dfa3
}
export function validateClip({ id, type, meta, data }, now = Date.now()) {
  if (typeof id !== 'string' || !UUID.test(id)) fail('clip id must be a UUID')
  const contentType = oneOf(String(type ?? '').split(';')[0].trim(), CLIP_TYPES, 'clip type')
  if (!looksLike(contentType, data)) fail('clip is not a valid video file')
  if (!meta || typeof meta !== 'object') fail('clip details are missing')
  if (!Number.isFinite(meta.startedAt) || meta.startedAt < EARLIEST || meta.startedAt > now + MAX_CLOCK_SKEW_MS) fail('clip time is out of range')
  if (!Number.isFinite(meta.durationMs) || meta.durationMs <= 0 || meta.durationMs > MAX_CLIP_MS) fail('clip length is out of range')
  if (!Array.isArray(meta.labels) || !meta.labels.length || meta.labels.length > MAX_CLIP_LABELS) fail(`a clip needs 1 to ${MAX_CLIP_LABELS} labels`)
  return {
    id:id.toLowerCase(), type:contentType, data,
    startedAt:Math.round(meta.startedAt), durationMs:Math.round(meta.durationMs), labels:meta.labels.map(clipLabel),
  }
}

// A typed question to a coach.
export const MAX_QUESTION_TEXT = 2000
function questionBase(body) {
  if (typeof body.id !== 'string' || !UUID.test(body.id)) fail('id must be a UUID')
  if (!Number.isInteger(body.coachId) || body.coachId < 1) fail('Choose a coach.')
  return { id:body.id.toLowerCase(), coachId:body.coachId }
}
export function validateQuestion(body) {
  if (!body || typeof body !== 'object') fail('Body must be a JSON object')
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) fail('Type a question.')
  if (text.length > MAX_QUESTION_TEXT) fail(`Questions are ${MAX_QUESTION_TEXT} characters at most.`)
  return { ...questionBase(body), text, recording:null }
}

// A recorded question: the body is the video (with sound), its details (coach, length and
// transcript) are in a header.
// About 600 kbit/s, so two minutes is roughly 9 MB.
export const MAX_RECORDING_BYTES = 16 * 1024 * 1024
export const MAX_RECORDING_MS = 2 * 60 * 1000
const RECORDING_TYPES = ['video/webm', 'video/mp4', 'audio/webm', 'audio/mp4', 'audio/ogg']
function looksLikeRecording(type, data) {
  if (type.endsWith('/mp4')) return data.length > 12 && data.toString('latin1', 4, 8) === 'ftyp'
  if (type === 'audio/ogg') return data.length > 4 && data.toString('latin1', 0, 4) === 'OggS'
  return data.length > 4 && data.readUInt32BE(0) === 0x1a45dfa3
}
export function validateRecordedQuestion({ id, type, meta, data }) {
  if (!meta || typeof meta !== 'object') fail('question details are missing')
  const contentType = oneOf(String(type ?? '').split(';')[0].trim(), RECORDING_TYPES, 'recording type')
  if (data.length > MAX_RECORDING_BYTES) fail('The recording is too large.')
  if (!looksLikeRecording(contentType, data)) fail('The recording is not a valid video file.')
  if (!Number.isFinite(meta.durationMs) || meta.durationMs <= 0 || meta.durationMs > MAX_RECORDING_MS + 5000) fail('The recording is too long (2 minutes at most).')
  // The automatic transcript, as the patient left it after checking; stored as the question's text.
  const transcript = meta.transcript === undefined || meta.transcript === null ? '' : typeof meta.transcript === 'string' ? meta.transcript.trim() : fail('transcript must be text')
  if (transcript.length > MAX_QUESTION_TEXT) fail(`The transcript is ${MAX_QUESTION_TEXT} characters at most.`)
  return { ...questionBase({ ...meta, id }), text:transcript, recording:{ type:contentType, data, durationMs:Math.round(meta.durationMs) } }
}

export function validateAnswer(body) {
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) fail('Type a reply.')
  if (text.length > MAX_QUESTION_TEXT) fail(`Replies are ${MAX_QUESTION_TEXT} characters at most.`)
  return text
}

// The plan editor sends every row each save, with the version it started from.
export function validatePlan(body) {
  if (!body || typeof body !== 'object') fail('Body must be a JSON object')
  if (!Number.isInteger(body.version) || body.version < 0) fail('version is required')
  if (!Array.isArray(body.items) || body.items.length > PLAN_LIMITS.rows) fail(`A plan holds at most ${PLAN_LIMITS.rows} exercises.`)
  const items = body.items.map((row, index) => {
    if (!row || typeof row !== 'object') fail(`Row ${index + 1} is not an object`)
    const exercise = row.exercise === null || row.exercise === undefined || row.exercise === '' ? null : row.exercise
    const result = planItem({ ...row, exercise, sets:String(row.sets ?? ''), reps:String(row.reps ?? ''), perWeek:String(row.perWeek ?? ''),
      days:Array.isArray(row.days) ? row.days : [], rest:String(row.rest ?? '') })
    return result.error ? fail(`Row ${index + 1}: ${result.error}.`) : result.item
  })
  return { items, version:body.version }
}
