// One Euro filter (Casiez et al. 2012): heavy smoothing when a value is still,
// light smoothing when it moves fast, so jitter drops without lagging real motion.
// Cutoffs are in Hz; beta scales with speed in units per second (degrees here).
export function createOneEuroFilter({ minCutoff = 1.5, beta = 0.03, derivativeCutoff = 1 } = {}) {
  let value = null
  let derivative = 0
  let lastTime
  const alpha = (cutoff, seconds) => 1 / (1 + 1 / (2 * Math.PI * cutoff * seconds))
  return {
    filter(raw, time) {
      if (value === null) {
        value = raw
        derivative = 0
        lastTime = time
        return value
      }
      const seconds = (time - lastTime) / 1000
      if (!(seconds > 0)) return value
      lastTime = time
      derivative += alpha(derivativeCutoff, seconds) * ((raw - value) / seconds - derivative)
      value += alpha(minCutoff + beta * Math.abs(derivative), seconds) * (raw - value)
      return value
    },
    reset() { value = null },
  }
}

// Smooths every metric of one tracked limb. Tracking gaps longer than maxGapMs
// restart the filters so a new position is not blended with a stale one.
// A metric can be missing (null) while others are tracked; it passes through as null
// and its own gap is timed separately.
export function createMetricSmoother(maxGapMs = 500, options) {
  let filters = {}
  return {
    smooth(metrics, now) {
      if (!metrics || !Number.isFinite(now)) return null
      const smoothed = {}
      for (const [name, value] of Object.entries(metrics)) {
        if (!Number.isFinite(value)) { smoothed[name] = null; continue }
        const entry = filters[name]
        if (!entry || now - entry.lastTime > maxGapMs || now < entry.lastTime) {
          filters[name] = { filter:createOneEuroFilter(options), lastTime:now }
        }
        filters[name].lastTime = now
        smoothed[name] = filters[name].filter.filter(value, now)
      }
      return smoothed
    },
    reset() { filters = {} },
  }
}

// Smooths drawn joint positions ({name:{x,y}} in pixels) so the skeleton holds
// still when the user does. Pixel speeds are far larger than angle speeds, so this
// uses a lower cutoff and beta: ~10 px of jitter settles to ~2 px at rest, with
// ~15 px of trail during a fast curl.
export function createPointSmoother(maxGapMs = 500, options = { minCutoff:0.5, beta:0.01 }) {
  const smoother = createMetricSmoother(maxGapMs, options)
  return {
    smooth(points, now) {
      if (!points) return null
      const flat = {}
      for (const [name, point] of Object.entries(points)) {
        flat[`${name}.x`] = point.x
        flat[`${name}.y`] = point.y
      }
      const smoothed = smoother.smooth(flat, now)
      if (!smoothed) return null
      return Object.fromEntries(Object.keys(points).map(name => [name, { x:smoothed[`${name}.x`], y:smoothed[`${name}.y`] }]))
    },
    reset: smoother.reset,
  }
}
