export function createAngleHistory(windowMs = 10000, maxGapMs = 500) {
  let samples = []
  return {
    add(time, angle) {
      samples.push({ time, angle: Number.isFinite(angle) ? angle : null })
      samples = samples.filter(point => point.time >= time - windowMs)
    },
    clear() { samples = [] },
    segments(now) {
      const segments = []
      let segment = null
      let previous
      for (const point of samples) {
        if (point.time < now - windowMs) continue
        if (point.angle === null) { segment = null; continue }
        if (!segment || point.time - previous > maxGapMs) {
          segment = []
          segments.push(segment)
        }
        segment.push(point)
        previous = point.time
      }
      return segments
    },
  }
}
