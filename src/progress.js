// Weekly progress for one patient: reps per week and the share of reps flagged.
// Two small charts on the same weeks rather than one chart with two scales.
// Weeks start on Monday in the viewer's own time zone.
export const PROGRESS_WEEKS = 12

export function weekStart(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - (date.getDay() + 6) % 7)
  return date.getTime()
}

// sessions: [{ startedAt, reps, flaggedReps, partialReps, fastReps, slowReps }]
export function weeklyProgress(sessions, now = Date.now(), weeks = PROGRESS_WEEKS) {
  const current = weekStart(now)
  const buckets = []
  for (let i = weeks - 1; i >= 0; i--) {
    // Stepping by calendar days, not 7 * DAY, keeps weeks aligned across daylight saving changes.
    const start = new Date(current)
    start.setDate(start.getDate() - i * 7)
    buckets.push({ start:start.getTime(), sessions:0, reps:0, flaggedReps:0, partialReps:0, tempoReps:0 })
  }
  for (const session of sessions) {
    const bucket = buckets.find(item => item.start === weekStart(session.startedAt))
    if (!bucket) continue
    bucket.sessions++
    bucket.reps += session.reps
    bucket.flaggedReps += session.flaggedReps
    bucket.partialReps += session.partialReps
    bucket.tempoReps += session.fastReps + session.slowReps
  }
  return buckets.map(bucket => ({ ...bucket, flaggedShare:bucket.reps ? bucket.flaggedReps / bucket.reps : null }))
}

const SVG = 'http://www.w3.org/2000/svg'
function svg(tag, attributes = {}, ...children) {
  const element = document.createElementNS(SVG, tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  element.append(...children)
  return element
}
const weekLabel = ms => new Date(ms).toLocaleDateString(undefined, { month:'short', day:'numeric' })

// A bar chart of one measure per week. Bars have rounded tops on a shared baseline,
// a native tooltip each, and the latest week's value written beside its bar.
function barChart({ weeks, value, format, max, title }) {
  const width = 600
  const height = 180
  const left = 48, right = 12, top = 22, bottom = 30
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const step = plotWidth / weeks.length
  const barWidth = Math.max(4, step - 6)
  const y = amount => top + plotHeight - (max ? amount / max : 0) * plotHeight
  const chart = svg('svg', { viewBox:`0 0 ${width} ${height}`, class:'progress-svg', role:'img', 'aria-label':title })
  for (const tick of [0, max / 2, max]) {
    chart.append(svg('line', { x1:left, x2:width - right, y1:y(tick), y2:y(tick), class:'progress-grid' }))
    chart.append(svg('text', { x:left - 6, y:y(tick) + 4, 'text-anchor':'end', class:'progress-axis' }, format(tick)))
  }
  weeks.forEach((week, index) => {
    const x = left + index * step + (step - barWidth) / 2
    const amount = value(week)
    // Every other week, counting back from the latest, so the newest is always labelled.
    if ((weeks.length - 1 - index) % 2 === 0) {
      chart.append(svg('text', { x:x + barWidth / 2, y:height - 8, 'text-anchor':'middle', class:'progress-axis' }, weekLabel(week.start)))
    }
    // A wider transparent target than the bar, so hovering a short bar still works.
    const target = svg('g', { class:'progress-bar' },
      svg('title', {}, `Week of ${weekLabel(week.start)}: ${!week.sessions ? 'no sessions' : amount === null ? 'no reps' : `${format(amount)} (${week.sessions} session${week.sessions === 1 ? '' : 's'})`}`),
      svg('rect', { x:left + index * step, y:top, width:step, height:plotHeight, fill:'transparent' }),
    )
    if (amount) {
      const barTop = y(amount)
      const radius = Math.min(4, barWidth / 2, (top + plotHeight - barTop) / 2)
      const path = `M${x},${top + plotHeight} V${barTop + radius} q0,-${radius} ${radius},-${radius} h${barWidth - 2 * radius} q${radius},0 ${radius},${radius} V${top + plotHeight} Z`
      target.append(svg('path', { d:path, class:'progress-fill' }))
    }
    chart.append(target)
    if (index === weeks.length - 1 && amount !== null) {
      chart.append(svg('text', { x:x + barWidth / 2, y:y(amount ?? 0) - 6, 'text-anchor':'middle', class:'progress-value' }, format(amount)))
    }
  })
  return chart
}

const niceMax = value => {
  if (value <= 0) return 10
  const magnitude = 10 ** Math.floor(Math.log10(value))
  return [1, 2, 5, 10].map(step => step * magnitude).find(step => step >= value)
}

// The panel: two charts and a table view of the same numbers.
export function progressCharts(sessions, h, now = Date.now()) {
  const weeks = weeklyProgress(sessions, now)
  if (!weeks.some(week => week.sessions)) {
    return h('p', { className:'hint' }, `No sessions in the last ${PROGRESS_WEEKS} weeks.`)
  }
  const percent = share => `${Math.round(share * 100)}%`
  const maxShare = Math.min(1, niceMax(Math.max(...weeks.map(week => week.flaggedShare ?? 0)) * 100) / 100) || 1
  const table = h('table', { className:'data-table' },
    h('thead', {}, h('tr', {}, ['Week of', 'Sessions', 'Reps', 'Flagged', 'Partial', 'Tempo off'].map(text => h('th', { scope:'col' }, text)))),
    h('tbody', {}, weeks.slice().reverse().map(week => h('tr', {},
      h('td', {}, weekLabel(week.start)),
      h('td', { className:'number' }, week.sessions),
      h('td', { className:'number' }, week.reps),
      h('td', { className:'number' }, week.reps ? `${week.flaggedReps} (${percent(week.flaggedShare)})` : '—'),
      h('td', { className:'number' }, week.partialReps),
      h('td', { className:'number' }, week.tempoReps),
    ))),
  )
  return h('div', { className:'progress' },
    h('div', { className:'progress-charts' },
      h('figure', {}, h('figcaption', {}, 'Reps per week'),
        barChart({ weeks, value:week => week.reps, format:amount => String(Math.round(amount)), max:Math.max(10, niceMax(Math.max(...weeks.map(week => week.reps)))), title:'Reps per week, last 12 weeks' })),
      h('figure', {}, h('figcaption', {}, 'Flagged reps, % of reps'),
        barChart({ weeks, value:week => week.flaggedShare, format:percent, max:maxShare, title:'Share of reps flagged for form, per week, last 12 weeks' })),
    ),
    h('details', {}, h('summary', {}, 'Show as table'), h('div', { className:'table-wrap' }, table)),
  )
}
