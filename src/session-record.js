const COUNTS = ['reps', 'flaggedReps', 'partialReps', 'fastReps', 'slowReps']

// What a lane did since `saved` (its report at the last save), so a run that
// resumes on the same trackers is never counted twice.
function since(report, saved) {
  if (!saved) return report
  const delta = { history:report.history.slice(saved.history.length) }
  for (const key of COUNTS) delta[key] = report[key] - saved[key]
  return delta
}

// Builds the record saved for one run from its lanes' tracker reports and marks
// the lanes as saved. Returns null when nothing happened, so idle runs are not stored.
export function buildSessionRecord({ id, exercise, source, side, angles, startedAt, endedAt, lanes }) {
  const reports = lanes.map(lane => {
    const report = lane.tracker.report()
    const delta = since(report, lane.saved)
    lane.saved = report
    return { side:lane.side, ...delta }
  })
  if (!startedAt || !reports.some(report => report.reps || report.partialReps)) return null
  return {
    id, exercise:exercise.id, source, side, angles,
    startedAt, endedAt:Math.max(startedAt, endedAt ?? startedAt),
    lanes:reports,
  }
}

export const sessionTotal = record => record.lanes.reduce((sum, lane) => sum + lane.reps, 0)

// randomUUID needs a secure context; getRandomValues also works over plain http (e.g. a phone on the LAN).
export function newRunId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
