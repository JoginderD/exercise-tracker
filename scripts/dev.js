// Starts the API server and the Vite dev server together, on one port setting, so
// the /api proxy always has something to forward to. Stopping either stops both.
import { spawn } from 'node:child_process'

const port = process.env.API_PORT ?? process.env.PORT ?? '8787'
// DEV_ACCOUNT_SWITCH turns on the password-free account switcher (server/index.js).
const env = { ...process.env, API_PORT:port, PORT:port, DEV_ACCOUNT_SWITCH:'1' }

const children = [
  spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', 'server/index.js'], { stdio:'inherit', env }),
  // npm puts node_modules/.bin on PATH, so `vite` resolves to the project's copy.
  spawn('vite', process.argv.slice(2), { stdio:'inherit', env }),
]

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
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0))
