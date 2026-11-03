// Decides which stretches of the recording become clips. Each flagged moment wants
// `before` ms of lead-in and `after` ms of follow-through; moments whose windows
// overlap share one clip, so a burst of warnings is one video, not five. Clips are
// capped at maxMs (keeping the end, where the latest moment is) and a session at
// maxClips (later moments are counted as dropped).
// Times are in the recorder's clock (performance.now() ms).
export const CLIP_DEFAULTS = { before:3000, after:3000, maxMs:20000, maxClips:20 }

export function createClipPlanner(options = {}) {
  const { before, after, maxMs, maxClips } = { ...CLIP_DEFAULTS, ...options }
  let open = null
  let made = 0
  let dropped = 0
  const ready = []

  function close() {
    if (!open) return
    ready.push(open)
    open = null
  }

  return {
    // event: { at, from?, ...label }. from is when the moment began, for events
    // reported at their end (a too-fast rep is judged once it is over).
    mark({ from, ...label }) {
      const start = Math.min(from ?? label.at, label.at) - before
      const end = label.at + after
      if (open && start <= open.end) {
        open.end = Math.max(open.end, end)
        open.start = Math.max(open.start, open.end - maxMs)
        open.labels.push(label)
        return
      }
      close()
      if (made >= maxClips) { dropped++; return }
      made++
      open = { start:Math.max(start, end - maxMs), end, labels:[label] }
    },
    // Clips whose follow-through has fully happened by now.
    due(now) {
      if (open && now >= open.end) close()
      return ready.splice(0)
    },
    // Everything still waiting, at the end of a session.
    flush() {
      close()
      return ready.splice(0)
    },
    get dropped() { return dropped },
  }
}
