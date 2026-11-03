import { h } from './dom.js'

// Light, dark or auto (follow the device's setting), chosen in the top bar and saved
// per device. index.html applies a saved choice before the first paint, so the page
// never flashes the wrong theme. Canvas drawings can't read CSS variables by
// themselves, so a 'themechange' event on document tells them to redraw.
const KEY = 'exercise-tracker:theme'
const CHOICES = [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]
const darkQuery = matchMedia('(prefers-color-scheme: dark)')
const buttons = new Set()

function saved() {
  try {
    const theme = localStorage.getItem(KEY)
    return theme === 'light' || theme === 'dark' ? theme : 'auto'
  } catch {
    return 'auto'
  }
}

function apply(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.theme === theme))
  changed()
}

function changed() {
  // The browser's own toolbar colour follows the page background.
  const background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background)
  document.dispatchEvent(new Event('themechange'))
}

export function choose(theme) {
  try {
    if (theme === 'auto') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, theme)
  } catch {}
  apply(theme)
}

// The segmented Auto / Light / Dark control for the top bar.
export function themeSwitch() {
  const group = h('div', { className:'theme-switch', role:'group', 'aria-label':'Colour theme' })
  const current = saved()
  for (const [theme, label] of CHOICES) {
    const button = h('button', { type:'button', 'data-theme':theme, 'aria-pressed':String(theme === current),
      title:theme === 'auto' ? 'Follow this device\'s light or dark setting' : `Always ${label.toLowerCase()}` }, label)
    button.addEventListener('click', () => choose(theme))
    buttons.add(button)
    group.append(button)
  }
  return group
}

// "Auto" follows the device as it changes (e.g. at sunset), and a choice made in
// another tab of the app applies here too.
darkQuery.addEventListener('change', () => { if (saved() === 'auto') changed() })
addEventListener('storage', event => { if (event.key === KEY || event.key === null) apply(saved()) })
apply(saved())
