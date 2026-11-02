import { exercises } from '../src/exercises.js'

// Everything here comes from the browser, so each field is checked and copied
// across explicitly: unknown fields are dropped, and sizes are capped so one
// request cannot store an unbounded blob.
const EXERCISE_IDS = new Set(exercises.map(exercise => exercise.id))
const MAX_REPS_PER_LANE = 2000
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
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function validateSignup(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!EMAIL.test(email) || email.length > 254) fail('Enter a valid email address.')
  if (!name || name.length > 100) fail('Enter your name (up to 100 characters).')
  if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 200) {
    fail('Password must be 10 to 200 characters.')
  }
  return { email, name, password:body.password, role:oneOf(body.role, ['patient', 'coach'], 'role') }
}
