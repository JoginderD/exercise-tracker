import { createHash, randomBytes } from 'node:crypto'

// Google sign-in: the OpenID Connect authorization code flow with PKCE, without an SDK.
// The ID token comes straight from Google's token endpoint over TLS, in exchange for
// the client secret, so its claims are trusted without checking the signature
// (OpenID Connect Core 3.1.3.7). Its audience, issuer, expiry and nonce are still checked.
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

export class GoogleError extends Error {}

// Sign-in with Google is on only when both values are set (see .env.example).
export function googleConfigFromEnv(env = process.env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null
  return { clientId:env.GOOGLE_CLIENT_ID, clientSecret:env.GOOGLE_CLIENT_SECRET, redirectUri:env.GOOGLE_REDIRECT_URI || null }
}

// Short-lived, one-use values keyed by a random token, held in memory: fine for one
// server process, like the rate limiters. Oldest entries go first when it is full.
export function createPendingStore(ttlMs, max = 10000) {
  const entries = new Map()
  const live = entry => entry && entry.expires > Date.now()
  return {
    put(value, token = randomBytes(24).toString('base64url')) {
      if (entries.size >= max) for (const [key, entry] of entries) if (!live(entry) || entries.size >= max) entries.delete(key)
      entries.set(token, { value, expires:Date.now() + ttlMs })
      return token
    },
    peek(token) {
      const entry = entries.get(token)
      return live(entry) ? entry.value : null
    },
    take(token) {
      const entry = entries.get(token)
      entries.delete(token)
      return live(entry) ? entry.value : null
    },
  }
}

export function authorizationRequest(config, redirectUri) {
  const state = randomBytes(24).toString('base64url')
  const nonce = randomBytes(24).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const url = new URL(config.authUrl ?? AUTH_URL)
  url.search = new URLSearchParams({
    client_id:config.clientId,
    redirect_uri:redirectUri,
    response_type:'code',
    scope:'openid email profile',
    state,
    nonce,
    code_challenge:createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method:'S256',
    prompt:'select_account',
  })
  return { url:url.href, state, flow:{ verifier, nonce, redirectUri } }
}

function tokenClaims(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')) }
  catch { return null }
}

// Returns the verified Google identity, or throws GoogleError.
export async function exchangeCode(config, code, { verifier, nonce, redirectUri }) {
  let response
  try {
    response = await fetch(config.tokenUrl ?? TOKEN_URL, {
      method:'POST',
      headers:{ 'content-type':'application/x-www-form-urlencoded' },
      body:new URLSearchParams({
        code, client_id:config.clientId, client_secret:config.clientSecret,
        redirect_uri:redirectUri, grant_type:'authorization_code', code_verifier:verifier,
      }),
      signal:AbortSignal.timeout(10000),
    })
  } catch (error) {
    throw new GoogleError(`Google token request failed: ${error.message}`)
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new GoogleError(`Google token request returned ${response.status}: ${body.error ?? 'no error code'}`)
  const claims = tokenClaims(body.id_token)
  if (!claims || !ISSUERS.includes(claims.iss) || claims.aud !== config.clientId || !(claims.exp * 1000 > Date.now())
    || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub) {
    throw new GoogleError('Google ID token failed validation')
  }
  // An unverified address could belong to someone else, so it cannot name an account.
  if (claims.email_verified !== true || typeof claims.email !== 'string') throw new GoogleError('Google account email is not verified')
  const email = claims.email.trim().toLowerCase()
  const name = (typeof claims.name === 'string' && claims.name.trim()) || email.split('@')[0]
  return { sub:claims.sub, email, name:name.slice(0, 100) }
}
