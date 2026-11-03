import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createApp } from '../server/index.js'
import { openStore } from '../server/store.js'

const CLIENT_ID = 'client-123.apps.googleusercontent.com'

// Stands in for Google's token endpoint. Each test sets the claims it answers with.
async function startFakeGoogle() {
  const requests = []
  let claimsFor = () => ({})
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const params = Object.fromEntries(new URLSearchParams(body))
    requests.push(params)
    const payload = Buffer.from(JSON.stringify(claimsFor(params))).toString('base64url')
    res.writeHead(200, { 'content-type':'application/json' })
    res.end(JSON.stringify({ id_token:`eyJhbGciOiJSUzI1NiJ9.${payload}.signature` }))
  })
  await new Promise(done => server.listen(0, done))
  return {
    url:`http://localhost:${server.address().port}/token`,
    requests,
    answer(fn) { claimsFor = fn },
    close:() => new Promise(done => server.close(done)),
  }
}

async function startServer(google) {
  const store = openStore(':memory:')
  const server = createApp({ store, google })
  await new Promise(done => server.listen(0, done))
  const base = `http://localhost:${server.address().port}`
  return { base, close:() => new Promise(done => server.close(done)) }
}

// A browser with a real cookie jar (several cookies, set and cleared) that does not follow redirects.
function browser(base) {
  const jar = new Map()
  return async function call(method, path, body) {
    const response = await fetch(base + path, {
      method,
      redirect:'manual',
      headers:{ ...body ? { 'content-type':'application/json' } : {}, cookie:[...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body:body ? JSON.stringify(body) : undefined,
    })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]
      if (/Max-Age=0/.test(line)) jar.delete(name)
      else jar.set(name, value)
    }
    const type = response.headers.get('content-type') ?? ''
    return { status:response.status, location:response.headers.get('location'), body:type.includes('json') ? await response.json() : null }
  }
}

const identity = (overrides = {}) => ({ nonce }) => ({
  iss:'https://accounts.google.com', aud:CLIENT_ID, exp:Math.floor(Date.now() / 1000) + 300, nonce,
  sub:'google-1', email:'Sam@Example.com', email_verified:true, name:'Sam Google', ...overrides,
})

// Runs the browser through Google: start, then come back to the callback with a code.
async function viaGoogle(call, google, claims, { code = 'auth-code' } = {}) {
  const start = await call('GET', '/api/auth/google/start')
  assert.equal(start.status, 302)
  const auth = new URL(start.location)
  const nonce = auth.searchParams.get('nonce')
  google.answer(params => claims({ nonce, params }))
  const back = await call('GET', `/api/auth/google/callback?state=${auth.searchParams.get('state')}&code=${code}`)
  assert.equal(back.status, 302)
  return { auth, location:back.location }
}

test('Google sign-in is off and hidden unless configured', async () => {
  const { base, close } = await startServer(null)
  try {
    const call = browser(base)
    assert.equal((await call('GET', '/api/me')).body.google, false)
    assert.equal((await call('GET', '/api/auth/google/start')).status, 404)
  } finally {
    await close()
  }
})

test('a new Google user picks a role, then comes back straight in', async () => {
  const google = await startFakeGoogle()
  const { base, close } = await startServer({ clientId:CLIENT_ID, clientSecret:'secret', authUrl:'https://accounts.google.test/auth', tokenUrl:google.url })
  try {
    const call = browser(base)
    assert.equal((await call('GET', '/api/me')).body.google, true)
    assert.equal((await call('POST', '/api/auth/google/complete', { name:'X', role:'patient' })).status, 410)

    const { auth, location } = await viaGoogle(call, google, identity())
    assert.equal(auth.origin + auth.pathname, 'https://accounts.google.test/auth')
    assert.equal(auth.searchParams.get('redirect_uri'), `${base}/api/auth/google/callback`)
    assert.equal(location, '/#google-signup')
    // The code is exchanged with the PKCE verifier matching the challenge sent to Google.
    const exchange = google.requests.at(-1)
    assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'), auth.searchParams.get('code_challenge'))
    assert.equal(exchange.redirect_uri, auth.searchParams.get('redirect_uri'))
    assert.equal(exchange.client_secret, 'secret')

    assert.equal((await call('GET', '/api/me')).body.user, null)
    assert.deepEqual((await call('GET', '/api/auth/google/pending')).body.pending, { kind:'signup', email:'sam@example.com', name:'Sam Google' })
    assert.equal((await call('POST', '/api/auth/google/complete', { name:'', role:'coach' })).status, 400)
    const done = await call('POST', '/api/auth/google/complete', { name:'Sam', role:'coach' })
    assert.equal(done.status, 201)
    assert.equal(done.body.user.email, 'sam@example.com')
    assert.match(done.body.user.coachCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
    assert.equal((await call('GET', '/api/me')).body.user.name, 'Sam')
    assert.equal((await call('GET', '/api/auth/google/pending')).body.pending, null)

    // A Google-only account has no password to guess.
    const other = browser(base)
    assert.equal((await other('POST', '/api/login', { email:'sam@example.com', password:'' })).status, 401)
    // Next time, on another device, Google signs straight in (coaches land on their patients).
    assert.equal((await viaGoogle(other, google, identity())).location, '/#patients')
    assert.equal((await other('GET', '/api/me')).body.user.role, 'coach')
  } finally {
    await close()
    await google.close()
  }
})

test('Google joins an existing password account only after that password is entered', async () => {
  const google = await startFakeGoogle()
  const { base, close } = await startServer({ clientId:CLIENT_ID, clientSecret:'secret', tokenUrl:google.url })
  try {
    // Anyone could register someone else's email with a password; Google must not walk into that account.
    const squatter = browser(base)
    await squatter('POST', '/api/signup', { email:'sam@example.com', name:'Sam', password:'correct horse', role:'patient' })

    const call = browser(base)
    assert.equal((await viaGoogle(call, google, identity())).location, '/#signin?google=link')
    assert.equal((await call('GET', '/api/me')).body.user, null)
    assert.equal((await call('POST', '/api/auth/google/complete', { name:'Sam', role:'patient' })).status, 410)
    assert.equal((await call('GET', '/api/auth/google/pending')).body.pending.kind, 'link')

    assert.equal((await call('POST', '/api/login', { email:'sam@example.com', password:'wrong password' })).status, 401)
    const login = await call('POST', '/api/login', { email:'sam@example.com', password:'correct horse' })
    assert.equal(login.status, 200)
    assert.equal(login.body.linkedGoogle, true)
    assert.equal((await call('GET', '/api/auth/google/pending')).body.pending, null)

    // Joined: Google now signs in, and the password still works.
    const phone = browser(base)
    assert.equal((await viaGoogle(phone, google, identity())).location, '/#')
    assert.equal((await phone('GET', '/api/me')).body.user.email, 'sam@example.com')
    assert.equal((await browser(base)('POST', '/api/login', { email:'sam@example.com', password:'correct horse' })).body.linkedGoogle, false)

    // A second Google account with the same email cannot take the account over.
    assert.equal((await viaGoogle(browser(base), google, identity({ sub:'google-2' }))).location, '/#signin?google=other-account')
  } finally {
    await close()
    await google.close()
  }
})

test('rejects forged, replayed, cancelled and unverified Google sign-ins', async () => {
  const google = await startFakeGoogle()
  const { base, close } = await startServer({ clientId:CLIENT_ID, clientSecret:'secret', tokenUrl:google.url })
  try {
    for (const claims of [
      identity({ nonce:'someone-elses-nonce' }),
      identity({ aud:'another-client' }),
      identity({ iss:'https://evil.example' }),
      identity({ exp:Math.floor(Date.now() / 1000) - 10 }),
      identity({ email_verified:false }),
      identity({ sub:'' }),
    ]) {
      const call = browser(base)
      assert.equal((await viaGoogle(call, google, claims)).location, '/#signin?google=failed')
      assert.equal((await call('GET', '/api/me')).body.user, null)
    }

    // The callback only completes in the browser that started the sign-in, and only once.
    const call = browser(base)
    const start = new URL((await call('GET', '/api/auth/google/start')).location)
    const state = start.searchParams.get('state')
    google.answer(({ params }) => identity()({ nonce:start.searchParams.get('nonce'), params }))
    assert.equal((await browser(base)('GET', `/api/auth/google/callback?state=${state}&code=x`)).location, '/#signin?google=expired')
    assert.equal((await call('GET', `/api/auth/google/callback?state=${state}&error=access_denied`)).location, '/#signin?google=cancelled')
    assert.equal((await call('GET', `/api/auth/google/callback?state=${state}&code=x`)).location, '/#signin?google=expired')
  } finally {
    await close()
    await google.close()
  }
})
