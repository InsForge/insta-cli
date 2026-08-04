import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { ApiClient, ApiError, linkedProject } from '../api.js'
import { ENVS, ENV_NAMES, envForApiUrl, isEnvName } from '../env.js'
import { info, die, printJson, promptPassword, openUrl } from '../util.js'

/** --api-url and --env both set the target host; --api-url wins (more specific), matching the
 *  INSTA_API_URL > INSTA_ENV precedence in config.ts. Returns the URL to point at, or undefined
 *  to leave whatever is already resolved alone. */
function targetApiUrl(opts: { apiUrl?: string; env?: string }): string | undefined {
  if (opts.apiUrl) return opts.apiUrl
  if (!opts.env) return undefined
  const want = opts.env.trim().toLowerCase()
  if (!isEnvName(want)) die(`unknown --env "${opts.env}" — expected one of: ${ENV_NAMES.join(', ')}`)
  return ENVS[want].api
}

export async function login(opts: { email?: string; password?: string; apiUrl?: string; env?: string; oauth?: string; device?: boolean }): Promise<void> {
  if (opts.device) return loginDevice(opts)
  if (opts.oauth) return loginOauth(opts.oauth, opts)
  const api = await ApiClient.load()
  const target = targetApiUrl(opts)
  if (target) api.setApiUrl(target)
  if (!opts.email) die('--email is required (or use --oauth <github|google>; on a headless machine, --device)')
  const password = opts.password ?? process.env.INSTA_PASSWORD ?? (await promptPassword())
  const res = await api.request('POST', '/auth/login', { email: opts.email, password }, { auth: false })
  api.setSession(res, res.user)
  await api.persist()
  info(`logged in as ${res.user.email ?? res.user.id} @ ${api.apiUrl}`)
}

// Browser OAuth (GitHub/Google) via a loopback listener. We open the platform's CLI-OAuth bridge,
// which runs Better Auth's social flow and bounces the resulting session token back to us.
export async function loginOauth(provider: string, opts: { apiUrl?: string; env?: string }): Promise<void> {
  if (provider !== 'github' && provider !== 'google') die('provider must be github or google')
  const api = await ApiClient.load()
  const target = targetApiUrl(opts)
  if (target) api.setApiUrl(target)
  const token = await browserOauth(api.apiUrl, provider)
  api.setSession({ accessToken: token, refreshToken: token })
  const me = await api.request<{ user: { id: string; email: string | null; name: string | null } }>('GET', '/me')
  api.setSession({ accessToken: token, refreshToken: token }, me.user)
  await api.persist()
  info(`logged in as ${me.user.email ?? me.user.id} @ ${api.apiUrl}`)
}

// RFC 8628 device authorization — login from a machine with no usable browser (VM, SSH box, CI
// container). The loopback --oauth flow can never work there: its callback targets 127.0.0.1 on
// THIS machine. Here the roles invert — we mint a code, print a link the human opens on ANY
// device, and poll the platform until they approve in the console.
export async function loginDevice(opts: { apiUrl?: string; env?: string }): Promise<void> {
  const api = await ApiClient.load()
  const target = targetApiUrl(opts)
  if (target) api.setApiUrl(target)
  const token = await deviceGrant((path, body) => api.request('POST', path, body, { auth: false }))
  api.setSession({ accessToken: token, refreshToken: token })
  const me = await api.request<{ user: { id: string; email: string | null; name: string | null } }>('GET', '/me')
  api.setSession({ accessToken: token, refreshToken: token }, me.user)
  await api.persist()
  info(`logged in as ${me.user.email ?? me.user.id} @ ${api.apiUrl}`)
}

// RFC 8628 §3.2: verification_uri_complete and interval are OPTIONAL in the authorization
// response, so don't trust either arithmetically without a fallback.
type DeviceStart = {
  device_code: string; user_code: string; verification_uri: string
  verification_uri_complete?: string; expires_in: number; interval?: number
}

export type DevicePoster = (path: string, body: Record<string, unknown>) => Promise<any>

const sleepSeconds = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000))

// Drives the device grant against the platform's Better Auth mount (/api/auth/device*) and
// returns the approved session token. Injectable poster + wait keep this testable without a
// network or real timers. Poll errors arrive as ApiError with the OAuth error code as message.
export async function deviceGrant(post: DevicePoster, wait: (s: number) => Promise<void> = sleepSeconds): Promise<string> {
  const start = (await post('/api/auth/device/code', { client_id: 'insta-cli' })) as DeviceStart
  // A missing/garbage expires_in must fail loudly here — carried into the deadline arithmetic it
  // becomes NaN, every `Date.now() < deadline` is false, and login dies as a bogus instant expiry.
  // Cap the lifetime too: a huge-but-finite value (Number.MAX_VALUE) overflows the ms conversion
  // to Infinity and would otherwise pin the CLI polling forever.
  const expiresIn = Number(start.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('malformed device authorization response (missing expires_in) — is the platform up to date?')
  }
  const lifetime = Math.min(expiresIn, 3600) // no device code sensibly outlives an hour
  info('to log in, open this link in a browser on any device:')
  info(`  ${start.verification_uri_complete ?? start.verification_uri}`)
  info(`and check it shows this code: ${start.user_code}`)
  info(`waiting for approval… (expires in ${Math.round(lifetime / 60)}m, ctrl-c to abort)`)
  // Absent OR non-finite interval = the RFC 8628 §3.2 default 5s: NaN would fire the timer
  // instantly and Infinity gets truncated to ~1ms by Node — both hot-poll the token endpoint.
  const rawInterval = Number(start.interval)
  let interval = Number.isFinite(rawInterval) ? Math.max(rawInterval, 1) : 5
  const deadline = Date.now() + lifetime * 1000
  while (Date.now() < deadline) {
    await wait(interval)
    try {
      const grant = (await post('/api/auth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: start.device_code,
        client_id: 'insta-cli',
      })) as { access_token?: string }
      // A 200 without a token must not become an empty stored session.
      if (!grant?.access_token) throw new Error('malformed token response (missing access_token)')
      return grant.access_token
    } catch (e) {
      const code = e instanceof ApiError ? e.message : ''
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') { interval += 5; continue } // RFC 8628 §3.5: back off by 5s
      if (code === 'expired_token') break
      if (code === 'access_denied') throw new Error('login request was denied in the console')
      throw e
    }
  }
  throw new Error('device login expired before it was approved — run `insta login --device` again')
}

// Start a loopback server, open the browser at the platform bridge, and await the token.
function browserOauth(apiUrl: string, provider: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const state = randomBytes(16).toString('hex')
    let timer: NodeJS.Timeout
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return }
      const token = url.searchParams.get('token')
      const err = url.searchParams.get('error')
      const ok = !!token && !err && url.searchParams.get('state') === state
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html' })
      res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;text-align:center;margin-top:4rem"><h2>InstaCloud</h2><p>${ok ? '✓ Login complete — you can close this tab.' : '✗ Login failed' + (err ? ` (${err})` : '')}</p></body>`)
      clearTimeout(timer)
      server.close()
      if (err) return reject(new Error(`oauth failed: ${err}`))
      if (!token) return reject(new Error('no token returned'))
      if (url.searchParams.get('state') !== state) return reject(new Error('state mismatch — aborting'))
      resolve(token)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const redirect = `http://127.0.0.1:${port}/callback`
      const authorizeUrl = `${apiUrl}/auth/cli/authorize?provider=${encodeURIComponent(provider)}&redirect=${encodeURIComponent(redirect)}&state=${state}`
      info(`opening browser to authorize with ${provider}…`)
      if (!openUrl(authorizeUrl)) info(`open this URL to continue:\n  ${authorizeUrl}`)
      timer = setTimeout(() => { server.close(); reject(new Error('timed out waiting for browser login (2m)')) }, 120_000)
    })
  })
}

export async function logout(): Promise<void> {
  const api = await ApiClient.load()
  if (api.config.refreshToken) {
    try { await api.request('POST', '/auth/logout', { refreshToken: api.config.refreshToken }, { auth: false }) } catch { /* ignore */ }
  }
  api.clearSession()
  await api.persist()
  info('logged out')
}

export async function status(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  let user: any = null
  try { user = (await api.request('GET', '/me')).user } catch { /* not logged in */ }
  const project = await linkedProject()
  // Surface the environment name alongside the URL: "api: https://api.staging.instacloud.com" is
  // easy to skim past, and mistaking staging for prod is the mistake worth making loud.
  const env = envForApiUrl(api.apiUrl)
  if (opts.json) return printJson({ env, apiUrl: api.apiUrl, user, project })
  info(`env:     ${env ?? '(custom)'}`)
  info(`api:     ${api.apiUrl}`)
  info(`user:    ${user ? (user.email ?? user.id) : '(not logged in)'}`)
  info(`project: ${project ? `${project.projectId} (branch ${project.branch})` : '(none linked)'}`)
}
