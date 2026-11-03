// Builds DOM nodes. Text children are set as text, never parsed as HTML, so
// names and emails typed by other users cannot inject markup.
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (name.startsWith('on')) element.addEventListener(name.slice(2), value)
    else if (name === 'className') element.className = value
    else element.setAttribute(name, value === true ? '' : value)
  }
  element.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false))
  return element
}

// Runs an async action with the button disabled and a pending label, then shows the outcome.
export async function withPending(button, pendingText, message, action) {
  const label = button.textContent
  button.disabled = true
  button.textContent = pendingText
  message.textContent = ''
  message.dataset.state = ''
  try {
    return await action()
  } catch (error) {
    message.dataset.state = 'error'
    message.textContent = error.message
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

export const when = ms => new Date(ms).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' })
export const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
