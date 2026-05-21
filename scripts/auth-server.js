const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { URL } = require('url')
const { google } = require('googleapis')

const rootDir = path.resolve(__dirname, '..')
const envPath = path.join(rootDir, '.env')
const storePath = path.join(rootDir, '.auth-store.json')

function loadEnvFile() {
  if (!fs.existsSync(envPath)) return

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue

    const [key, ...rest] = trimmed.split('=')
    if (!process.env[key]) {
      process.env[key] = rest.join('=').replace(/^['"]|['"]$/g, '')
    }
  }
}

loadEnvFile()

const port = Number(process.env.SYPHER_AUTH_PORT || process.env.IRIS_AUTH_PORT || 3000)
const backendOrigin = process.env.VITE_BACKEND_KEY || `http://localhost:${port}`
const callbackUrl =
  process.env.GOOGLE_OAUTH_REDIRECT_URI || `${backendOrigin.replace(/\/+$/, '')}/users/google/callback`
const appRedirectUrl =
  process.env.SYPHER_AUTH_REDIRECT_URI ||
  process.env.IRIS_AUTH_REDIRECT_URI ||
  'sypher://auth/callback'
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const scopes = ['openid', 'email', 'profile']
const pendingStates = new Set()

function getConfigStatus() {
  return {
    ok: Boolean(clientId && clientSecret),
    port,
    backendOrigin,
    callbackUrl,
    appRedirectUrl,
    hasGoogleClientId: Boolean(clientId),
    hasGoogleClientSecret: Boolean(clientSecret)
  }
}

function readStore() {
  try {
    if (!fs.existsSync(storePath)) return { sessions: {} }
    return JSON.parse(fs.readFileSync(storePath, 'utf8'))
  } catch {
    return { sessions: {} }
  }
}

function writeStore(store) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2))
}

function createToken() {
  return crypto.randomBytes(32).toString('base64url')
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'text/plain; charset=utf-8'
  })
  res.end(body)
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store'
  })
  res.end()
}

function getOAuthClient() {
  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET in .env')
  }

  return new google.auth.OAuth2(clientId, clientSecret, callbackUrl)
}

function createSession(user) {
  const now = Date.now()
  const accessToken = createToken()
  const refreshToken = createToken()
  const store = readStore()

  store.sessions[refreshToken] = {
    user,
    accessTokens: {
      [accessToken]: now + ACCESS_TOKEN_TTL_MS
    },
    refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
    createdAt: now
  }

  writeStore(store)
  return { accessToken, refreshToken }
}

function refreshSession(refreshToken) {
  const store = readStore()
  const session = store.sessions[refreshToken]
  const now = Date.now()

  if (!session || session.refreshExpiresAt < now) {
    if (session) {
      delete store.sessions[refreshToken]
      writeStore(store)
    }
    return null
  }

  const accessToken = createToken()
  session.accessTokens = {
    [accessToken]: now + ACCESS_TOKEN_TTL_MS
  }

  writeStore(store)
  return { accessToken, refreshToken, user: session.user }
}

function findUserByAccessToken(accessToken) {
  const store = readStore()
  const now = Date.now()
  let changed = false

  for (const [refreshToken, session] of Object.entries(store.sessions)) {
    if (session.refreshExpiresAt < now) {
      delete store.sessions[refreshToken]
      changed = true
      continue
    }

    const expiresAt = session.accessTokens?.[accessToken]
    if (expiresAt && expiresAt >= now) {
      if (changed) writeStore(store)
      return session.user
    }
  }

  if (changed) writeStore(store)
  return null
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) {
        req.destroy()
        reject(new Error('Request body too large'))
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

async function handleGoogleStart(_req, res) {
  if (!clientId || !clientSecret) {
    sendJson(res, 503, {
      message: 'Google OAuth is not configured.',
      missing: [
        ...(!clientId ? ['GOOGLE_OAUTH_CLIENT_ID'] : []),
        ...(!clientSecret ? ['GOOGLE_OAUTH_CLIENT_SECRET'] : [])
      ],
      callbackUrl
    })
    return
  }

  const oauth2Client = getOAuthClient()
  const state = createToken()
  pendingStates.add(state)

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state
  })

  redirect(res, url)
}

async function handleGoogleCallback(req, res) {
  const requestUrl = new URL(req.url, backendOrigin)
  const code = requestUrl.searchParams.get('code')
  const state = requestUrl.searchParams.get('state')
  const error = requestUrl.searchParams.get('error')

  if (error) {
    sendText(res, 400, `Google OAuth failed: ${error}`)
    return
  }

  if (!code || !state || !pendingStates.has(state)) {
    sendText(res, 400, 'Invalid OAuth callback state.')
    return
  }

  pendingStates.delete(state)

  const oauth2Client = getOAuthClient()
  const { tokens } = await oauth2Client.getToken(code)
  oauth2Client.setCredentials(tokens)

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
  const { data } = await oauth2.userinfo.get()
  const user = {
    id: data.id,
    email: data.email,
    name: data.name || data.email || 'Sypher Operator',
    picture: data.picture || null,
    linkedAt: new Date().toISOString()
  }

  const session = createSession(user)
  const redirectTarget = new URL(appRedirectUrl)
  redirectTarget.searchParams.set('accessToken', session.accessToken)
  redirectTarget.searchParams.set('refreshToken', session.refreshToken)

  redirect(res, redirectTarget.toString())
}

async function handleRefreshToken(req, res) {
  const rawBody = await readRequestBody(req)
  const body = rawBody ? JSON.parse(rawBody) : {}
  const session = refreshSession(body.refreshToken)

  if (!session) {
    sendJson(res, 401, { message: 'Invalid refresh token.' })
    return
  }

  sendJson(res, 200, {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    user: session.user
  })
}

function handleCurrentUser(req, res) {
  const authHeader = req.headers.authorization || ''
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const user = findUserByAccessToken(accessToken)

  if (!user) {
    sendJson(res, 401, { message: 'Unauthorized.' })
    return
  }

  sendJson(res, 200, {
    user,
    data: user
  })
}

async function handleRequest(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {})
      return
    }

    const requestUrl = new URL(req.url, backendOrigin)

    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'sypher-auth',
        config: getConfigStatus()
      })
      return
    }

    if (req.method === 'GET' && requestUrl.pathname === '/users/google') {
      await handleGoogleStart(req, res)
      return
    }

    if (req.method === 'GET' && requestUrl.pathname === '/users/google/callback') {
      await handleGoogleCallback(req, res)
      return
    }

    if (req.method === 'POST' && requestUrl.pathname === '/users/refresh-token') {
      await handleRefreshToken(req, res)
      return
    }

    if (req.method === 'GET' && requestUrl.pathname === '/users/me') {
      handleCurrentUser(req, res)
      return
    }

    sendJson(res, 404, { message: 'Route not found.' })
  } catch (error) {
    sendJson(res, 500, { message: error.message || 'Internal auth error.' })
  }
}

function createAuthServer() {
  return http.createServer(handleRequest)
}

function startAuthServer() {
  const server = createAuthServer()

  server.listen(port, () => {
    console.log(`[SYPHER AUTH] Listening on http://localhost:${port}`)
    console.log(`[SYPHER AUTH] Google callback: ${callbackUrl}`)

    if (!clientId || !clientSecret) {
      console.log('[SYPHER AUTH] Google OAuth credentials missing in .env')
    }
  })

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[SYPHER AUTH] Port ${port} is already in use.`)
    } else {
      console.error(`[SYPHER AUTH] ${error.message}`)
    }
    process.exitCode = 1
  })

  return server
}

if (require.main === module) {
  startAuthServer()
}

module.exports = {
  createAuthServer,
  getConfigStatus,
  startAuthServer
}
