// Determines which patients on a coach's roster may need attention.
// Checks unanswered questions, safety alerts, flagged exercise repetitions,
// and inactivity based on recent workout sessions.

const DAY = 24 * 60 * 60 * 1000
export const ATTENTION = {
  recentDays:7,
  // The comparison window before the recent one, for "flagged reps are rising".
  priorDays:21,
  // Too few reps make a percentage meaningless: 1 flagged of 2 is not 50% of anything.
  minReps:10,
  // Percentage points the flagged share must rise by.
  risePoints:15,
  // A first week with no history to compare against is called out above this share.
  highShare:0.5,
}

// Calculates the proportion of exercise repetitions that were flagged.
const share = sessions => {
  const reps = sessions.reduce((sum, session) => sum + session.reps, 0)
  const flagged = sessions.reduce((sum, session) => sum + session.flaggedReps, 0)
  return { reps, value:reps ? flagged / reps : 0 }
}

// Reviews a patient's activity and returns reasons they may need attention from their coach.
export function attentionReasons(patient, sessions, now = Date.now(), rules = ATTENTION) {
  const reasons = []
  if (patient.openQuestions?.count) {
    reasons.push({ kind:'question', priority:'high', count:patient.openQuestions.count, since:patient.openQuestions.oldestAt })
  }
  const recentFrom = now - rules.recentDays * DAY
  const priorFrom = recentFrom - rules.priorDays * DAY
  const recent = sessions.filter(session => session.startedAt >= recentFrom)
  const prior = sessions.filter(session => session.startedAt >= priorFrom && session.startedAt < recentFrom)

  const alerts = recent.filter(session => session.safety)
  if (alerts.length) {
    reasons.push({ kind:'safety', sessions:alerts.length, at:Math.max(...alerts.map(session => session.startedAt)) })
  }

  const lately = share(recent)
  const before = share(prior)
  if (lately.reps >= rules.minReps) {
    if (before.reps >= rules.minReps && (lately.value - before.value) * 100 >= rules.risePoints) {
      reasons.push({ kind:'flagged', from:Math.round(before.value * 100), to:Math.round(lately.value * 100) })
    } else if (before.reps < rules.minReps && lately.value >= rules.highShare) {
      reasons.push({ kind:'flagged', from:null, to:Math.round(lately.value * 100) })
    }
  }

  // Measured from the last session, or from linking for someone who never started.
  const since = patient.lastSessionAt ?? patient.linkedAt
  const idleDays = Math.floor((now - since) / DAY)
  if (idleDays >= rules.recentDays) reasons.push({ kind:'inactive', days:idleDays, never:!patient.lastSessionAt })

  return reasons
}
