import { createAngleHistory } from './angle-history.js'

export function createAngleGraph(canvas) {
  const ctx = canvas.getContext('2d')
  let thresholds = []
  let series = []
  let lastTime = 0

  function draw(now = lastTime) {
    lastTime = now
    const width = canvas.clientWidth || 600
    const height = 240
    const ratio = window.devicePixelRatio || 1
    // Resizing reallocates the backing store, so only do it when the size changes.
    const pixelWidth = Math.round(width * ratio)
    const pixelHeight = Math.round(height * ratio)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, pixelWidth, pixelHeight)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    const left = 44, right = width - 16, top = 16, bottom = height - 34
    const x = time => left + (time - now + 10000) / 10000 * (right - left)
    const y = angle => bottom - angle / 180 * (bottom - top)
    // Colours come from the page theme (src/style.css); line colours are CSS variable names.
    const css = getComputedStyle(canvas)
    const token = name => css.getPropertyValue(name).trim()
    ctx.font = '12px Figtree, Arial, sans-serif'
    ctx.lineWidth = 1
    ctx.textAlign = 'right'
    for (const angle of [0, 45, 90, 135, 180]) {
      ctx.fillStyle = token('--text-muted')
      ctx.fillText(`${angle}°`, left - 8, y(angle) + 4)
      ctx.strokeStyle = token('--border')
      ctx.beginPath(); ctx.moveTo(left, y(angle)); ctx.lineTo(right, y(angle)); ctx.stroke()
    }
    ctx.textAlign = 'center'
    for (const seconds of [-10, -8, -6, -4, -2, 0]) {
      ctx.fillText(seconds === 0 ? 'Now' : `${seconds}s`, x(now + seconds * 1000), height - 10)
    }
    ctx.setLineDash([5, 5])
    ctx.strokeStyle = token('--border-strong')
    for (const angle of thresholds) {
      ctx.beginPath(); ctx.moveTo(left, y(angle)); ctx.lineTo(right, y(angle)); ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.lineWidth = 2
    for (const { history, color } of series) {
      ctx.strokeStyle = token(color)
      ctx.fillStyle = token(color)
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
  }
  new ResizeObserver(() => draw()).observe(canvas)
  document.addEventListener('themechange', () => draw())
  draw()
  return {
    // lines: [{ id, color }], color a CSS variable name; values passed to add() are keyed by line id.
    configure(lines, angles) {
      series = lines.map(line => ({ ...line, history: createAngleHistory() }))
      thresholds = angles
      draw(0)
    },
    add(time, values) {
      for (const line of series) line.history.add(time, values[line.id])
      draw(time)
    },
    clear() { for (const line of series) line.history.clear(); draw(0) },
  }
}
