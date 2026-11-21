// Starts the frontend and backend development servers together.
// Runs the backend API server and Vite for the website.
// If either server stops, the other is also stopped.

import { spawn } from 'node:child_process'

// Sets the backend port to 8787 unless another port is specified.
const port = process.env.API_PORT ?? process.env.PORT ?? '8787'

// Configures the server environment and enables development account switching.
const env = { ...process.env, API_PORT:port, PORT:port, DEV_ACCOUNT_SWITCH:'1' }

// Starts the backend API server and Vite frontend development server.
const children = [
  spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', 'server/index.js'], { stdio:'inherit', env }),
  // Uses the project's installed version of Vite.
  spawn('vite', process.argv.slice(2), { stdio:'inherit', env }),
]

// Stops both servers if either one exits or encounters an error.
let stopping = false
function stop(code) {
  if (stopping) return
  stopping = true
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  process.exitCode = code
}

for (const child of children) {
  child.on('exit', code => stop(code ?? 0))
  child.on('error', error => { console.error(error.message); stop(1) })
}

// Handles shutdown signals from the terminal.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0))
