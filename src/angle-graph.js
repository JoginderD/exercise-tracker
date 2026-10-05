import { createAngleHistory } from './angle-history.js'

export function createAngleGraph(canvas, thresholds) {
  const ctx = canvas.getContext('2d')
  const history = createAngleHistory()
  let lastTime = 0

  function draw(now = lastTime) {
    lastTime = now
    const width = canvas.clientWidth || 600
    const height = 240
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    const left = 44, right = width - 16, top = 16, bottom = height - 34
    const x = time => left + (time - now + 10000) / 10000 * (right - left)
    const y = angle => bottom - angle / 180 * (bottom - top)
    ctx.font = '12px Arial'
    ctx.lineWidth = 1
    ctx.textAlign = 'right'
    for (const angle of [0, 45, 90, 135, 180]) {
      ctx.fillStyle = '#cbd5e1'
      ctx.fillText(`${angle}°`, left - 8, y(angle) + 4)
      ctx.strokeStyle = '#334155'
      ctx.beginPath(); ctx.moveTo(left, y(angle)); ctx.lineTo(right, y(angle)); ctx.stroke()
    }
    ctx.textAlign = 'center'
    for (const seconds of [-10, -8, -6, -4, -2, 0]) {
      ctx.fillText(seconds === 0 ? 'Now' : `${seconds}s`, x(now + seconds * 1000), height - 10)
    }
    ctx.setLineDash([5, 5])
    ctx.strokeStyle = '#a78bfa'
    for (const angle of thresholds) {
      ctx.beginPath(); ctx.moveTo(left, y(angle)); ctx.lineTo(right, y(angle)); ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.strokeStyle = '#22d3ee'
    ctx.fillStyle = '#22d3ee'
    ctx.lineWidth = 2
    for (const segment of history.segments(now)) {
      ctx.beginPath()
      segment.forEach((point, index) => {
        if (index === 0) ctx.moveTo(x(point.time), y(point.angle))
        else ctx.lineTo(x(point.time), y(point.angle))
      })
      ctx.stroke()
      if (segment.length === 1) {
        ctx.beginPath(); ctx.arc(x(segment[0].time), y(segment[0].angle), 2, 0, 2 * Math.PI); ctx.fill()
      }
    }
  }
  new ResizeObserver(() => draw()).observe(canvas)
  draw()
  return {
    add(time, angle) { history.add(time, angle); draw(time) },
    clear() { history.clear(); draw(0) },
  }
}
